import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { fileURLToPath } from "node:url";
import protoLoader from "@grpc/proto-loader";
import { isIPv4 } from "node:net";
import { hostname, networkInterfaces, platform } from "node:os";
import { Protocol, getResponder } from "@homebridge/ciao";
import { createReadStream, existsSync, statSync } from "node:fs";
import { z as z$1 } from "zod";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy/api";
import { SessionId, foldSurface } from "@deepseek-ai/dsh-session";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import grpc from "@grpc/grpc-js";
import { sanitizeRemoteWorkspaceName } from "@w2112515/dsh-remote-host/command";
import { EventEmitter } from "node:events";
//#region src/host/pairing-admin.ts
/** Host-local pairing administration over the shared durable security owner. */
const PROFILE_CAPABILITIES = {
	"read-only": "3",
	"session-control": "71",
	"session-operator": "79",
	"approval-reviewer": "19",
	"session-supervisor": "95",
	"host-supervisor": "351"
};
/** Empty discovery view used until the carrier publishes, or when LAN stays off. */
const REMOTE_LAN_DISCOVERY_OFF = {
	intended: false,
	published: false
};
/**
* Local administration owner. This object is provided only inside the Host
* Cordis context; the mobile carrier never serializes its methods or views.
*/
var RemotePairingAdministrator = class {
	security;
	onAuthorizationChanged;
	onLanDiscoveryChange;
	#endpointHost;
	#port;
	#discovery = REMOTE_LAN_DISCOVERY_OFF;
	constructor(security, endpointHost, endpointPort, onAuthorizationChanged = () => {}, onLanDiscoveryChange) {
		this.security = security;
		this.onAuthorizationChanged = onAuthorizationChanged;
		this.onLanDiscoveryChange = onLanDiscoveryChange;
		this.#endpointHost = endpointHost;
		this.#port = endpointPort;
	}
	/**
	* Update an OS-assigned test port after the carrier binds.
	* @param port - bound IPv4 loopback port.
	*/
	setEndpointPort(port) {
		this.setEndpoint(this.#endpointHost, port);
	}
	/**
	* Point later invitations at the address the carrier currently binds.
	* @param host - IPv4 bind address.
	* @param port - bound TCP port.
	*/
	setEndpoint(host, port) {
		if (host.trim() === "") throw new Error("invalid pairing endpoint host");
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid pairing endpoint port");
		this.#endpointHost = host;
		this.#port = port;
	}
	/** Current LAN advertisement facts for the Host-local settings page. */
	discovery() {
		return this.#discovery;
	}
	/**
	* Record the live advertisement after a successful bind or withdraw.
	* @param value - actual published state, not merely operator intent.
	*/
	setDiscovery(value) {
		this.#discovery = value;
	}
	/**
	* Persist operator intent and rebind when this Host wired a settings owner.
	* @param enabled - whether nearby phones should discover this Host.
	*/
	async setLanDiscovery(enabled) {
		if (this.onLanDiscoveryChange === void 0) throw new Error("LAN discovery cannot be changed in this deployment");
		this.#discovery = await this.onLanDiscoveryChange(enabled);
		return this.#discovery;
	}
	/**
	* Mint one five-minute invitation for an exact closed Host-selected profile.
	* @param profile - explicit local access profile; read-only remains the default.
	* @param lifetimeMs - invitation lifetime in milliseconds.
	* @param nowMs - Host wall-clock timestamp.
	* @returns safe Host-local invitation view.
	*/
	createInvitation(profile = "read-only", lifetimeMs = 3e5, nowMs = Date.now()) {
		if (!Object.hasOwn(PROFILE_CAPABILITIES, profile)) throw new Error("unsupported Remote pairing profile");
		const invitation = this.security.createInvitation(nowMs, lifetimeMs, PROFILE_CAPABILITIES[profile], this.#endpointHost, this.#port);
		try {
			return invitationView(invitation);
		} finally {
			invitation.invitationPsk.fill(0);
		}
	}
	/**
	* List only Noise-authenticated ceremonies that require local review.
	* @returns current immutable review rows.
	*/
	pendingPairings() {
		return this.security.pendingPairings().map(pendingView);
	}
	/**
	* Commit the exact pending identity with the invitation-bound profile.
	* @param invitationId - reviewed invitation identifier.
	* @param nowMs - Host wall-clock timestamp.
	* @returns durable authorization view.
	*/
	confirm(invitationId, nowMs = Date.now()) {
		return deviceView(this.security.confirmPairing(parseIdentifier(invitationId), nowMs));
	}
	/**
	* Reject and retire a pending invitation without creating authorization.
	* @param invitationId - reviewed invitation identifier.
	*/
	reject(invitationId) {
		this.security.rejectPairing(parseIdentifier(invitationId));
	}
	/**
	* List active and revoked device records for Host-local administration.
	* @returns current durable device views.
	*/
	devices() {
		return this.security.listDevices().map(deviceView);
	}
	/**
	* Revoke one durable device identity, advance its fencing epoch, and terminate stale live authority.
	* @param deviceId - durable Host device identifier.
	* @param nowMs - Host wall-clock timestamp.
	* @returns whether an active authorization changed.
	*/
	revoke(deviceId, nowMs = Date.now()) {
		const changed = this.security.revoke(parseIdentifier(deviceId), nowMs);
		if (changed) this.onAuthorizationChanged(deviceId.toLowerCase());
		return changed;
	}
};
let cachedInvitationCodec;
function invitationCodec() {
	if (cachedInvitationCodec !== void 0) return cachedInvitationCodec;
	const path = fileURLToPath(new URL("../protocol/v1alpha/dsh_remote_v1alpha.proto", import.meta.url));
	const codec = protoLoader.loadSync(path, {
		defaults: true,
		enums: String,
		keepCase: true,
		longs: String,
		oneofs: true
	})["dsh.remote.v1alpha.PairingInvitation"];
	if (codec === void 0 || typeof codec.serialize !== "function") throw new Error("pairing invitation protobuf codec is unavailable");
	cachedInvitationCodec = codec;
	return codec;
}
function invitationView(invitation) {
	const bytes = invitationCodec().serialize({
		protocol_version: 1,
		invitation_id: invitation.invitationId,
		invitation_psk: invitation.invitationPsk,
		host_public_key: invitation.hostPublicKey,
		expires_at_ms: invitation.expiresAtMs,
		capabilities: invitation.capabilities,
		endpoint_host: invitation.endpointHost,
		endpoint_port: invitation.endpointPort
	});
	return {
		invitationId: invitation.invitationId.toString("hex"),
		invitationUri: `dsh-remote://pair/v1#${bytes.toString("base64url")}`,
		hostFingerprint: fingerprint(invitation.hostPublicKey),
		expiresAtMs: invitation.expiresAtMs,
		capabilities: invitation.capabilities,
		profile: profileForCapabilities(invitation.capabilities)
	};
}
function pendingView(value) {
	return {
		invitationId: value.invitationId.toString("hex"),
		deviceName: value.deviceName,
		deviceFingerprint: fingerprint(value.devicePublicKey),
		verificationCode: value.verificationCode,
		expiresAtMs: value.expiresAtMs,
		capabilities: value.capabilities,
		profile: profileForCapabilities(value.capabilities)
	};
}
function deviceView(value) {
	return {
		deviceId: value.deviceId.toString("hex"),
		displayName: value.displayName,
		deviceFingerprint: fingerprint(value.publicKey),
		capabilities: value.capabilities,
		createdAtMs: value.createdAtMs,
		...value.revokedAtMs === void 0 ? {} : { revokedAtMs: value.revokedAtMs },
		authorityEpoch: value.authorityEpoch,
		profile: profileForCapabilities(value.capabilities)
	};
}
function fingerprint(publicKey) {
	const hex = createHash("sha256").update(publicKey).digest("hex").toUpperCase();
	return Array.from({ length: hex.length / 4 }, (_, index) => hex.slice(index * 4, index * 4 + 4)).join(" ");
}
function parseIdentifier(value) {
	if (!/^[0-9a-f]{32}$/i.test(value)) throw new Error("identifier must be 16-byte hexadecimal");
	return Buffer.from(value, "hex");
}
function profileForCapabilities(capabilities) {
	for (const profile of [
		"read-only",
		"approval-reviewer",
		"session-control",
		"session-operator",
		"session-supervisor",
		"host-supervisor"
	]) if (PROFILE_CAPABILITIES[profile] === capabilities) return profile;
	throw new Error("device authorization uses an unsupported Remote profile");
}
//#endregion
//#region src/host/discovery.ts
/** Privacy-minimized DNS-SD advertisement for an explicitly LAN-bound Host. */
/** DNS-SD service queried by the native Android discovery flow. */
const REMOTE_DISCOVERY_SERVICE_TYPE = "dsh-remote";
function isLanIpv4(address) {
	const octets = address.split(".").map((value) => Number.parseInt(value, 10));
	if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
	const [first = -1, second = -1] = octets;
	return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first === 169 && second === 254 || first === 100 && second >= 64 && second <= 127;
}
function lanCandidateAddress(candidate) {
	return typeof candidate === "string" ? candidate : candidate.address;
}
function lanCandidateName(candidate) {
	return typeof candidate === "string" ? "" : candidate.name ?? "";
}
function isLinkLocalIpv4(address) {
	return address.startsWith("169.254.");
}
function isCgnatIpv4(address) {
	const [first = -1, second = -1] = address.split(".").map((value) => Number.parseInt(value, 10));
	return first === 100 && second >= 64 && second <= 127;
}
const VIRTUAL_INTERFACE = new RegExp([
	"vmware|vmnet|vethernet|hyper-?v|virtualbox|vbox|wsl|docker|virbr",
	"tailscale|zerotier|hamachi|radmin|mihomo|clash|npcap|bluetooth",
	"isatap|teredo|loopback|pseudo|tap-|tun-|\\bvpn\\b"
].join("|"), "i");
function isVirtualInterfaceName(name) {
	return name !== "" && VIRTUAL_INTERFACE.test(name);
}
function isWifiInterfaceName(name) {
	return /wi-?fi|wlan|无线/i.test(name);
}
function isEthernetInterfaceName(name) {
	return /ethernet|以太网|local area connection/i.test(name);
}
/** Higher ranks win; `0` is ignored by automatic selection. */
function autoRank(candidate) {
	const address = lanCandidateAddress(candidate);
	if (!isLanIpv4(address) || isLinkLocalIpv4(address) || isCgnatIpv4(address)) return 0;
	const name = lanCandidateName(candidate);
	if (isVirtualInterfaceName(name)) return 0;
	if (isWifiInterfaceName(name)) return 3;
	if (isEthernetInterfaceName(name)) return 2;
	return 1;
}
/**
* Resolve one phone-reachable private IPv4 interface.
* Virtual, link-local and CGNAT/VPN addresses are ignored unless the operator
* names them with `lanAddress`. Two remaining physical LANs still fail closed.
* @param preferredAddress - Optional operator-selected address.
* @returns The unique eligible LAN address.
*/
function resolveRemoteLanAddress(preferredAddress) {
	const candidates = [];
	for (const [name, entries] of Object.entries(networkInterfaces())) for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal && isLanIpv4(entry.address)) candidates.push({
		name,
		address: entry.address
	});
	return selectRemoteLanAddress(candidates, preferredAddress);
}
/**
* Select one private interface from a captured Host network snapshot.
* @param candidates - Active non-loopback IPv4 interfaces, optionally named.
* @param preferredAddress - Optional operator-selected address.
* @returns The unique eligible LAN address.
*/
function selectRemoteLanAddress(candidates, preferredAddress) {
	const usable = candidates.filter((candidate) => isLanIpv4(lanCandidateAddress(candidate)));
	const unique = [...new Set(usable.map(lanCandidateAddress))].sort();
	if (preferredAddress !== void 0) {
		if (!isIPv4(preferredAddress) || !isLanIpv4(preferredAddress) || !unique.includes(preferredAddress)) throw new Error("host-remote: lanAddress must be an active private IPv4 interface");
		return preferredAddress;
	}
	if (unique.length === 0) throw new Error("host-remote: LAN discovery found no private IPv4 interface");
	const ranked = usable.map((candidate) => ({
		address: lanCandidateAddress(candidate),
		rank: autoRank(candidate)
	})).filter((entry) => entry.rank > 0);
	const bestRank = ranked.reduce((best, entry) => Math.max(best, entry.rank), 0);
	const chosen = [...new Set(ranked.filter((entry) => entry.rank === bestRank).map((entry) => entry.address))].sort();
	if (chosen.length === 1) return chosen[0];
	const options = (chosen.length > 1 ? chosen : unique).join(", ");
	throw new Error(`host-remote: LAN discovery is ambiguous; choose lanAddress from ${options}`);
}
/**
* Validate and minimize the public discovery record before multicast publication.
* @param options - Operator identity, bound endpoint and stable Host public key.
* @returns Bounded advertisement fields with no DSH Session metadata.
*/
function resolveRemoteLanAdvertisement(options) {
	const displayName = options.displayName.trim();
	if (displayName.length === 0 || Buffer.byteLength(displayName, "utf8") > 63) throw new Error("host-remote: lanDisplayName must contain 1-63 UTF-8 bytes");
	if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("host-remote: LAN discovery port is invalid");
	if (options.hostPublicKey.length !== 32) throw new Error("host-remote: Host public key is invalid");
	return {
		displayName,
		address: resolveRemoteLanAddress(options.address),
		port: options.port,
		hostId: remoteLanHostId(options.hostPublicKey),
		platform: platform()
	};
}
/**
* Derive the non-secret stable discovery identity from the Host public key.
* @param hostPublicKey - Pinned 32-byte Host public key.
* @returns Uppercase SHA-256 fingerprint without separators.
*/
function remoteLanHostId(hostPublicKey) {
	if (hostPublicKey.length !== 32) throw new Error("host-remote: Host public key is invalid");
	return createHash("sha256").update(hostPublicKey).digest("hex").toUpperCase();
}
/**
* Build the complete allowlisted TXT record.
* @param resolved - Validated advertisement identity.
* @returns Exact public discovery fields.
*/
function remoteLanDiscoveryTxt(resolved) {
	return {
		v: "1",
		id: resolved.hostId,
		platform: resolved.platform,
		pairing: "required"
	};
}
/**
* Publish one RFC 6763 service and return a goodbye-packet disposal closure.
* @param resolved - Validated privacy-minimized advertisement.
* @param onNameChange - Observes a DNS-SD conflict rename (another responder
* on the LAN already defends this instance name); absent, ciao's fallback
* console warning stays.
* @returns Async cleanup that withdraws the service and closes its responder.
*/
async function advertiseRemoteLanHost(resolved, onNameChange) {
	return await advertiseLanService(resolved, REMOTE_DISCOVERY_SERVICE_TYPE, remoteLanDiscoveryTxt(resolved), { ...onNameChange === void 0 ? {} : { onNameChange } });
}
async function advertiseLanService(resolved, serviceType, txt, options) {
	const responder = getResponder({
		interface: resolved.address,
		disableIpv6: true
	});
	const service = responder.createService({
		name: resolved.displayName,
		type: serviceType,
		protocol: Protocol.TCP,
		port: resolved.port,
		restrictedAddresses: [resolved.address],
		disabledIpv6: true,
		txt,
		...options?.hostname === void 0 ? {} : { hostname: options.hostname }
	});
	const onNameChange = options?.onNameChange;
	if (onNameChange !== void 0) service.on("name-change", onNameChange);
	try {
		await service.advertise();
	} catch (error) {
		await responder.shutdown().catch(() => void 0);
		throw error;
	}
	return async () => {
		try {
			await service.destroy();
		} finally {
			await responder.shutdown();
		}
	};
}
//#endregion
//#region src/host/lan-settings.ts
/** Operator-owned LAN settings helpers for the live `host-remote` section. */
/** Settings namespace the Web plugin card and Mobile access page both write. */
const HOST_REMOTE_SETTINGS_NAMESPACE = settingsNamespace("host-remote");
/** Schema of the user-owned Remote LAN section. */
const HOST_REMOTE_SETTINGS_SCHEMA = z.object({
	lanDiscovery: z.boolean().default(false),
	lanDisplayName: z.string().default(""),
	lanAddress: z.string().default("")
});
/** Composition entry projected into the `host-remote` settings namespace. */
function hostRemoteSettingsEntry(config) {
	return {
		lanDiscovery: config.lanDiscovery === true,
		lanDisplayName: config.lanDisplayName ?? "",
		lanAddress: config.lanAddress ?? ""
	};
}
/** DNS-SD instance name: operator string, else the machine hostname. */
function resolvedLanDisplayName(value) {
	const named = value.lanDisplayName.trim();
	return named === "" ? hostname() : named;
}
/** Whether two LAN sections would bind the same advertisement. */
function sameHostRemoteSettings(left, right) {
	return left.lanDiscovery === right.lanDiscovery && left.lanDisplayName === right.lanDisplayName && left.lanAddress === right.lanAddress;
}
/**
* Reject a LAN-on section the carrier could not bind.
* @param value - resolved settings section.
* @param port - configured carrier port.
* @param hostPublicKey - native Host identity, absent when the addon did not load.
*/
function validateHostRemoteSettings(value, port, hostPublicKey) {
	if (value.lanDiscovery !== true) return;
	if (hostPublicKey === void 0) throw new Error("host-remote: LAN discovery requires the native security owner");
	resolveRemoteLanAdvertisement({
		displayName: resolvedLanDisplayName(value),
		...value.lanAddress.trim() === "" ? {} : { address: value.lanAddress.trim() },
		port,
		hostPublicKey
	});
}
//#endregion
//#region src/host/path-minimize.ts
/**
* Carrier path minimization: workspace roots are matching keys, never wire
* content. The artifact registry (roster rows) and the projection (timeline
* tool cards) share these primitives so both minimize identically.
* @module @deepseek-ai/dsh-host-remote/src/path-minimize
*/
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
/**
* Normalize separator style before any comparison or slicing.
* @param path - The raw carried path.
* @returns The same path with forward slashes only.
*/
function normalizeSlashes(path) {
	return path.replaceAll("\\", "/");
}
/**
* Whether the normalized path names a root (POSIX, UNC, or drive).
* @param path - The slash-normalized path.
* @returns True when the path is absolute.
*/
function isAbsolutePath(path) {
	return path.startsWith("/") || path.startsWith("\\\\") || DRIVE_ABSOLUTE.test(path);
}
/**
* Final path component.
* @param path - The slash-normalized path.
* @returns Everything after the last separator; the whole path when there is none.
*/
function basenameOf(path) {
	return path.slice(path.lastIndexOf("/") + 1);
}
/**
* Minimized path plus the internal absolute form, never guessing relativity.
* @param rawPath - The carried path as the tool reported it.
* @param cwd - The session workspace root, when the Host knows it.
* @returns The workspace-relative path, or the final component when outside;
*   `fullPath` is the internal absolute form for the fetch ACL, absent when
*   the path was relative and no workspace fact resolves it.
*/
function minimizePath(rawPath, cwd) {
	const normalized = normalizeSlashes(rawPath);
	if (!isAbsolutePath(normalized)) {
		if (cwd === void 0) return {
			minimized: normalized,
			outside: false
		};
		return {
			minimized: normalized,
			outside: false,
			fullPath: `${normalizeSlashes(cwd).replace(/\/+$/, "")}/${normalized}`
		};
	}
	if (cwd !== void 0) {
		const root = normalizeSlashes(cwd).replace(/\/+$/, "");
		if (root !== "" && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return {
			minimized: normalized.slice(root.length + 1),
			outside: false,
			fullPath: normalized
		};
	}
	return {
		minimized: basenameOf(normalized),
		outside: true,
		fullPath: normalized
	};
}
//#endregion
//#region src/host/artifact-registry.ts
/**
* Resolve registry behavior explicitly; every bound has a stated default.
* @param request Construction request.
* @returns The fully-resolved spec.
*/
function resolveArtifactRegistrySpec(request) {
	return {
		listSessions: request.listSessions,
		readHistory: request.readHistory,
		maxSessions: request.maxSessions ?? 20,
		maxEventsPerSession: request.maxEventsPerSession ?? 500,
		rosterCap: request.rosterCap ?? 100,
		contentCharCap: request.contentCharCap ?? 8192,
		rememberCap: request.rememberCap ?? 400
	};
}
/**
* Narrow an opaque hunk carrier — the result `meta`, or the call view as the
* create fallback — to applied hunks; malformed input is absent.
*/
function hunksFromMeta(meta) {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return void 0;
	const diffs = meta.diffs;
	if (!Array.isArray(diffs) || diffs.length === 0) return void 0;
	for (const diff of diffs) {
		if (typeof diff !== "object" || diff === null || Array.isArray(diff)) return void 0;
		const { path, oldText, newText } = diff;
		if (typeof path !== "string" || oldText !== null && typeof oldText !== "string" || typeof newText !== "string") return;
	}
	return diffs;
}
/** One call-view location path; line numbers are follow-along detail, dropped. */
function locationPaths(view) {
	if (!("locations" in view) || !Array.isArray(view.locations)) return [];
	return view.locations.map((location) => typeof location === "object" && location !== null ? location.path : void 0).filter((path) => typeof path === "string" && path !== "");
}
/**
* Paths a call view reports having created or changed, by render intent rather
* than tool name: a diff card, or a generic card whose kind is `edit`. Every
* other card produces nothing to open — a read looked, a delete removed, a
* terminal ran.
*/
function producedPaths(view) {
	if (view === void 0) return [];
	if (view.card === "diff") return locationPaths(view);
	if (view.card === "generic" && "kind" in view && view.kind === "edit") return locationPaths(view);
	return [];
}
/**
* Bound the applied-hunk content to whole hunks: a cut mid-string would ship
* invalid JSON, so the largest fitting prefix crosses and the drop is marked.
*/
function boundContent(hunks, contentCharCap) {
	if (hunks === void 0) return { truncated: false };
	const kept = [];
	for (const hunk of hunks) {
		if (JSON.stringify([...kept, hunk]).length > contentCharCap) break;
		kept.push(hunk);
	}
	if (kept.length === 0) return { truncated: hunks.length > 0 };
	return {
		content: JSON.stringify(kept),
		truncated: kept.length < hunks.length
	};
}
/** Derive the create fact: every applied hunk has no prior text. */
function deriveIsNewFile(hunks) {
	return hunks !== void 0 && hunks.every((hunk) => hunk.oldText === null);
}
function artifactId(sessionId, seq, pathIndex) {
	return `${sessionId}:${seq}:${pathIndex}`;
}
/**
* Create the registry. The remembered map is bounded by
* {@link ArtifactRegistrySpec.rememberCap}; eviction loses only the fetch ACL
* for entries older than every scan window, never roster honesty.
* @param spec Fully-resolved registry behavior.
* @returns The ready registry.
*/
function createArtifactRegistry(spec) {
	const remembered = /* @__PURE__ */ new Map();
	const callViews = /* @__PURE__ */ new Map();
	function remember(entry) {
		if (remembered.has(entry.wire.artifact_id)) return;
		remembered.set(entry.wire.artifact_id, entry);
		if (remembered.size <= spec.rememberCap) return;
		let oldestId = entry.wire.artifact_id;
		let oldestAt = entry.registeredAtMs;
		let oldestSeq = entry.seq;
		for (const [candidateId, value] of remembered) if (value.registeredAtMs < oldestAt || value.registeredAtMs === oldestAt && value.seq < oldestSeq) {
			oldestId = candidateId;
			oldestAt = value.registeredAtMs;
			oldestSeq = value.seq;
		}
		remembered.delete(oldestId);
	}
	function recognizeResult(sessionId, cwd, callView, event) {
		const paths = producedPaths(callView);
		if (paths.length === 0) return [];
		const data = event.data;
		if (data.message.content[0]?.isError === true) return [];
		const hunks = hunksFromMeta(data.meta) ?? hunksFromMeta(callView);
		const bounded = boundContent(hunks, spec.contentCharCap);
		const isNewFile = deriveIsNewFile(hunks);
		const rows = [];
		paths.forEach((path, pathIndex) => {
			const minimized = minimizePath(path, cwd);
			const wire = {
				artifact_id: artifactId(sessionId, event.seq, pathIndex),
				session_id: sessionId,
				path: minimized.minimized,
				outside_workspace: minimized.outside,
				is_new_file: isNewFile,
				...bounded.content === void 0 ? {} : { content: bounded.content },
				truncated: bounded.truncated,
				registered_at_ms: String(event.time)
			};
			remember({
				seq: event.seq,
				registeredAtMs: event.time,
				...minimized.fullPath === void 0 ? {} : { fullPath: minimized.fullPath },
				wire
			});
			rows.push(wire);
		});
		return rows;
	}
	function scanEntries(sessionId, cwd, entries) {
		const calls = /* @__PURE__ */ new Map();
		for (const entry of entries) {
			const { event, view } = entry;
			if (event.type === "tool/call") {
				if (view?.for === "call") calls.set(event.data.callId, view.view);
				continue;
			}
			if (event.type !== "tool/result") continue;
			const callId = String(event.data.message.source.callId);
			recognizeResult(sessionId, cwd, calls.get(callId), event);
		}
	}
	return {
		async roster() {
			const sessions = (await spec.listSessions()).slice().sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, spec.maxSessions);
			for (const session of sessions) {
				const page = await spec.readHistory(session.sessionId, spec.maxEventsPerSession);
				scanEntries(session.sessionId, page.cwd, page.entries);
			}
			return [...remembered.values()].sort((a, b) => b.registeredAtMs - a.registeredAtMs || b.seq - a.seq).slice(0, spec.rosterCap).map((entry) => entry.wire);
		},
		observeLive(input) {
			const { sessionId, event, view } = input;
			const cwd = input.cwd;
			if (event.type === "tool/call") {
				if (view?.for === "call") {
					let table = callViews.get(sessionId);
					if (table === void 0) callViews.set(sessionId, table = /* @__PURE__ */ new Map());
					table.set(event.data.callId, view.view);
				}
				return [];
			}
			if (event.type === "turn/end") {
				callViews.delete(sessionId);
				return [];
			}
			if (event.type !== "tool/result") return [];
			const callId = String(event.data.message.source.callId);
			return recognizeResult(sessionId, cwd, callViews.get(sessionId)?.get(callId), event);
		},
		resolve(requestedId, sessionId) {
			const entry = remembered.get(requestedId);
			if (entry === void 0 || entry.wire.session_id !== sessionId || entry.fullPath === void 0) return;
			return { path: entry.fullPath };
		}
	};
}
//#endregion
//#region src/host/blob-transfer.ts
/**
* Blob transfer assembler (S-blob, ADR-005): bounded, resumable, verify-then-commit
* chunk assembly for the remote carrier's blob logical channel. Chunks arrive
* offset-addressed over the authenticated carrier; this module stages them under
* a private directory, resumes by cursor after reconnect or Host restart, and
* commits only after the declared size and SHA-256 both verify. Every failure is
* transfer-scoped — nothing here may tear down the carrier connection.
*/
/**
* Largest chunk payload the carrier accepts in one frame: the Noise plaintext
* ceiling (65,519) minus envelope headroom. Protocol constant, not a tunable.
*/
const BLOB_CHUNK_BYTES = 49152;
/** Wire-safe transfer id: lowercase hex the client mints per transfer. */
const BLOB_TRANSFER_ID_PATTERN = /^[0-9a-f]{16,64}$/;
/** Lowercase hex SHA-256 digest of the full blob content. */
const BLOB_SHA256_PATTERN = /^[0-9a-f]{64}$/;
/**
* A transfer-scoped failure. Carrying `code` lets the carrier answer honestly
* without inspecting messages; `resumeOffset` tells the sender where to continue
* after `offset-mismatch`.
*/
var BlobTransferError = class extends Error {
	code;
	resumeOffset;
	/**
	* @param code Stable machine-readable failure code.
	* @param message Operator-facing detail; never blob content.
	* @param resumeOffset Current contiguous cursor when the sender must resume.
	*/
	constructor(code, message, resumeOffset) {
		super(message);
		this.code = code;
		this.resumeOffset = resumeOffset;
		this.name = "BlobTransferError";
	}
};
/**
* Resolve assembler behavior explicitly (no hidden defaults inside the
* assembler itself).
* @param request Construction request with optional bounds.
* @returns The fully-resolved assembler spec.
*/
function resolveBlobTransferSpec(request) {
	return {
		stagingDir: request.stagingDir,
		maxBlobBytes: request.maxBlobBytes ?? 104857600,
		transferTtlMs: request.transferTtlMs ?? 864e5,
		maxActiveTransfers: request.maxActiveTransfers ?? 2,
		now: request.now ?? Date.now,
		commit: request.commit
	};
}
/**
* Create the assembler and sweep whatever an earlier process left behind.
* @param spec Fully-resolved assembler behavior.
* @returns The ready assembler.
*/
async function createBlobTransferAssembler(spec) {
	await mkdir(spec.stagingDir, {
		recursive: true,
		mode: 448
	});
	const active = /* @__PURE__ */ new Map();
	const partPath = (transferId) => join(spec.stagingDir, `${transferId}.part`);
	const sidecarPath = (transferId) => join(spec.stagingDir, `${transferId}.json`);
	async function removeStaging(transferId) {
		await rm(partPath(transferId), { force: true });
		await rm(sidecarPath(transferId), { force: true });
	}
	function validateDeclaration(declaration) {
		if (!BLOB_TRANSFER_ID_PATTERN.test(declaration.transferId)) throw new BlobTransferError("invalid-declaration", "transfer id must be 16..64 lowercase hex characters");
		if (!BLOB_SHA256_PATTERN.test(declaration.sha256Hex)) throw new BlobTransferError("invalid-declaration", "sha256 must be 64 lowercase hex characters");
		if (!Number.isSafeInteger(declaration.totalBytes) || declaration.totalBytes < 1) throw new BlobTransferError("invalid-declaration", "total bytes must be a positive safe integer");
		if (declaration.totalBytes > spec.maxBlobBytes) throw new BlobTransferError("invalid-declaration", `declared ${declaration.totalBytes} bytes exceeds the ${spec.maxBlobBytes} byte bound`);
	}
	function declarationsMatch(a, b) {
		return a.sha256Hex === b.sha256Hex && a.totalBytes === b.totalBytes && a.mediaType === b.mediaType;
	}
	async function load(transferId) {
		const remembered = active.get(transferId);
		if (remembered !== void 0) return remembered;
		let sidecar;
		try {
			sidecar = JSON.parse(await readFile(sidecarPath(transferId), "utf8"));
		} catch {
			return;
		}
		const staged = await stat(partPath(transferId)).catch(() => void 0);
		if (staged === void 0) {
			await removeStaging(transferId);
			return;
		}
		const adopted = {
			declaration: {
				transferId,
				sha256Hex: sidecar.sha256Hex,
				totalBytes: sidecar.totalBytes,
				...sidecar.mediaType === void 0 ? {} : { mediaType: sidecar.mediaType }
			},
			receivedBytes: staged.size,
			lastActivityMs: staged.mtimeMs
		};
		active.set(transferId, adopted);
		return adopted;
	}
	async function countActive() {
		return (await readdir(spec.stagingDir)).filter((entry) => entry.endsWith(".json")).length;
	}
	async function sweep() {
		const cutoff = spec.now() - spec.transferTtlMs;
		const entries = await readdir(spec.stagingDir);
		for (const entry of entries) {
			if (!entry.endsWith(".part") && !entry.endsWith(".json")) continue;
			const path = join(spec.stagingDir, entry);
			/* v8 ignore next 3 -- readdir/stat race: the file vanishing between the
			two calls cannot be staged deterministically. */
			const staged = await stat(path).catch(() => void 0);
			if (staged === void 0) continue;
			if (staged.mtimeMs <= cutoff) {
				const transferId = entry.slice(0, entry.lastIndexOf("."));
				active.delete(transferId);
				await removeStaging(transferId);
			}
		}
	}
	await sweep();
	return {
		async begin(declaration) {
			validateDeclaration(declaration);
			const existing = await load(declaration.transferId);
			if (existing !== void 0) {
				if (!declarationsMatch(declaration, existing.declaration)) throw new BlobTransferError("declaration-conflict", "transfer id already stages different content; abort it or mint a new id", existing.receivedBytes);
				existing.lastActivityMs = spec.now();
				return { receivedBytes: existing.receivedBytes };
			}
			if (await countActive() >= spec.maxActiveTransfers) throw new BlobTransferError("too-many-transfers", "the active transfer budget is exhausted; finish or abort first");
			await mkdir(spec.stagingDir, { recursive: true });
			const sidecar = {
				sha256Hex: declaration.sha256Hex,
				totalBytes: declaration.totalBytes,
				...declaration.mediaType === void 0 ? {} : { mediaType: declaration.mediaType }
			};
			try {
				await writeFile(sidecarPath(declaration.transferId), JSON.stringify(sidecar), {
					flag: "wx",
					mode: 384
				});
				await writeFile(partPath(declaration.transferId), /* @__PURE__ */ new Uint8Array(0), {
					flag: "wx",
					mode: 384
				});
			} catch (error) {
				await removeStaging(declaration.transferId);
				throw new BlobTransferError(
					"declaration-conflict",
					/* v8 ignore next -- node:fs rejections are always Error; the String arm is defensive. */
					`transfer id could not be staged exclusively: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			const started = {
				declaration,
				receivedBytes: 0,
				lastActivityMs: spec.now()
			};
			active.set(declaration.transferId, started);
			return { receivedBytes: 0 };
		},
		async chunk(transferId, offset, data) {
			const state = await load(transferId);
			if (state === void 0) throw new BlobTransferError("unknown-transfer", "transfer is unknown, expired, or already finalized");
			if (offset !== state.receivedBytes) throw new BlobTransferError("offset-mismatch", "chunk does not continue the staged cursor", state.receivedBytes);
			if (data.length < 1) throw new BlobTransferError("size-mismatch", "chunk payload must not be empty", state.receivedBytes);
			if (data.length > 49152) throw new BlobTransferError("chunk-too-large", `chunk payload exceeds the ${BLOB_CHUNK_BYTES} byte frame bound`, state.receivedBytes);
			if (state.receivedBytes + data.length > state.declaration.totalBytes) throw new BlobTransferError("size-mismatch", "chunk overruns the declared total", state.receivedBytes);
			const handle = await open(partPath(transferId), "a");
			try {
				await handle.write(data);
			} finally {
				await handle.close();
			}
			state.receivedBytes += data.length;
			state.lastActivityMs = spec.now();
			return { receivedBytes: state.receivedBytes };
		},
		async complete(transferId) {
			const state = await load(transferId);
			if (state === void 0) throw new BlobTransferError("unknown-transfer", "transfer is unknown, expired, or already finalized");
			if (state.receivedBytes !== state.declaration.totalBytes) throw new BlobTransferError("size-mismatch", "declared content is not fully staged", state.receivedBytes);
			const path = partPath(transferId);
			const flush = await open(path, "r+");
			try {
				await flush.sync();
			} finally {
				await flush.close();
			}
			const hash = createHash("sha256");
			for await (const block of createReadStream(path)) hash.update(block);
			if (hash.digest("hex") !== state.declaration.sha256Hex) {
				await removeStaging(transferId);
				active.delete(transferId);
				throw new BlobTransferError("digest-mismatch", "staged content does not match the declared sha256");
			}
			let blobId;
			try {
				blobId = await spec.commit({
					path,
					declaration: state.declaration
				});
			} catch (error) {
				await removeStaging(transferId);
				active.delete(transferId);
				throw new BlobTransferError("commit-rejected", `the blob owner refused the verified content: ${error instanceof Error ? error.message : String(error)}`);
			}
			await removeStaging(transferId);
			active.delete(transferId);
			return { blobId };
		},
		async abort(transferId) {
			active.delete(transferId);
			await removeStaging(transferId);
		},
		async status(transferId) {
			const state = await load(transferId);
			return state === void 0 ? void 0 : { receivedBytes: state.receivedBytes };
		},
		sweep,
		async dispose() {
			const entries = await readdir(spec.stagingDir).catch(() => []);
			for (const entry of entries) {
				if (!entry.endsWith(".part") && !entry.endsWith(".json")) continue;
				const transferId = entry.slice(0, entry.lastIndexOf("."));
				active.delete(transferId);
				await removeStaging(transferId);
			}
		}
	};
}
//#endregion
//#region src/host/blob-fetch.ts
/**
* Blob fetch server (S-blob, ADR-005): the Host half of the download direction.
* Each fetch session proves its ACL once at open (attachment: the session-log
* reference proof, artifact: registry membership — both injected), then serves
* offset-addressed contiguous chunks the carrier maps onto blob_fetch frames.
* Attachment payloads are deployment-bounded images held whole in memory;
* artifact payloads are pread from an open handle so a 100 MiB artifact never
* loads fully. Every failure is fetch-scoped — nothing here may tear down the
* carrier connection.
*/
/** A fetch-scoped failure carrying a stable machine-readable code. */
var BlobFetchError = class extends Error {
	code;
	/**
	* @param code Stable machine-readable failure code.
	* @param message Operator-facing detail; never blob content.
	*/
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "BlobFetchError";
	}
};
/**
* Resolve fetch-server behavior explicitly (no hidden defaults inside the server).
* @param request Construction request with optional bounds.
* @returns The fully-resolved fetch-server spec.
*/
function resolveBlobFetchSpec(request) {
	return {
		maxFetches: request.maxFetches ?? 4,
		fetchTtlMs: request.fetchTtlMs ?? 36e5,
		maxBlobBytes: request.maxBlobBytes ?? 104857600,
		now: request.now ?? Date.now,
		resolveAttachment: request.resolveAttachment,
		readAttachment: request.readAttachment,
		resolveArtifact: request.resolveArtifact
	};
}
const ATTACHMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_SOURCE_ID_BYTES = 512;
/**
* Create the fetch server. Resolution callbacks are invoked once per open, so
* a multi-hundred-chunk artifact download proves its ACL exactly once.
* @param spec Fully-resolved fetch-server behavior.
* @returns The ready fetch server.
*/
function createBlobFetchServer(spec) {
	const sessions = /* @__PURE__ */ new Map();
	function sourceKey(source) {
		return source.kind === "attachment" ? `attachment:${source.attachmentId}:${source.sessionId}` : `artifact:${source.artifactId}:${source.sessionId}`;
	}
	function validateOpen(request) {
		if (!BLOB_TRANSFER_ID_PATTERN.test(request.fetchId)) throw new BlobFetchError("invalid-request", "fetch id must be 16..64 lowercase hex characters");
		const source = request.source;
		if (source.sessionId.length === 0 || new TextEncoder().encode(source.sessionId).length > MAX_SOURCE_ID_BYTES) throw new BlobFetchError("invalid-request", "session id must be non-empty and bounded");
		if (source.kind === "attachment") {
			if (!ATTACHMENT_ID_PATTERN.test(source.attachmentId)) throw new BlobFetchError("invalid-request", "attachment id must be a content-addressed sha256 reference");
		} else if (source.artifactId.length === 0 || new TextEncoder().encode(source.artifactId).length > MAX_SOURCE_ID_BYTES) throw new BlobFetchError("invalid-request", "artifact id must be non-empty and bounded");
	}
	async function release(session) {
		const releasePayload = session.release;
		delete session.release;
		await releasePayload?.();
	}
	async function openAttachment(source) {
		const ref = await spec.resolveAttachment(source.attachmentId, source.sessionId);
		if (ref === void 0) throw new BlobFetchError("unauthorized", "the session does not reference this attachment");
		const data = await spec.readAttachment(ref);
		if (data.length < 1) throw new BlobFetchError("invalid-request", "referenced attachment is empty");
		if (data.length > spec.maxBlobBytes) throw new BlobFetchError("content-too-large", "referenced attachment exceeds the fetch ceiling");
		return {
			sourceKey: sourceKey(source),
			totalBytes: data.length,
			sha256Hex: source.attachmentId.slice(7),
			mediaType: ref.mediaType,
			readSlice: (offset, length) => Promise.resolve(data.subarray(offset, offset + length)),
			lastActivityMs: spec.now()
		};
	}
	async function openArtifact(source) {
		const resolved = await spec.resolveArtifact(source.artifactId, source.sessionId);
		if (resolved === void 0) throw new BlobFetchError("unauthorized", "the session does not reference this artifact");
		const observed = await stat(resolved.path);
		if (observed.size < 1) throw new BlobFetchError("invalid-request", "referenced artifact is empty");
		if (observed.size > spec.maxBlobBytes) throw new BlobFetchError("content-too-large", "referenced artifact exceeds the fetch ceiling");
		const handle = await open(resolved.path, "r");
		return {
			sourceKey: sourceKey(source),
			totalBytes: observed.size,
			readSlice: async (offset, length) => {
				const buffer = new Uint8Array(length);
				let read = 0;
				while (read < length) {
					const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
					if (bytesRead === 0) throw new BlobFetchError("source-changed", "artifact shrank after the fetch was opened; re-open to re-declare");
					read += bytesRead;
				}
				return buffer;
			},
			release: async () => {
				await handle.close();
			},
			lastActivityMs: spec.now()
		};
	}
	function factsOf(session) {
		const opened = { totalBytes: session.totalBytes };
		if (session.sha256Hex !== void 0) opened.sha256Hex = session.sha256Hex;
		if (session.mediaType !== void 0) opened.mediaType = session.mediaType;
		return opened;
	}
	return {
		async open(request) {
			validateOpen(request);
			const key = sourceKey(request.source);
			const existing = sessions.get(request.fetchId);
			if (existing !== void 0) {
				if (existing.sourceKey !== key) throw new BlobFetchError("fetch-conflict", "fetch id already serves a different source");
				existing.lastActivityMs = spec.now();
				return factsOf(existing);
			}
			if (sessions.size >= spec.maxFetches) throw new BlobFetchError("too-many-fetches", "the fetch session budget is exhausted; close or let sessions expire");
			const session = request.source.kind === "attachment" ? await openAttachment(request.source) : await openArtifact(request.source);
			sessions.set(request.fetchId, session);
			return factsOf(session);
		},
		async chunk(fetchId, offset, maxBytes) {
			const session = sessions.get(fetchId);
			if (session === void 0) throw new BlobFetchError("unknown-fetch", "fetch session is unknown, expired, or closed");
			if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes)) throw new BlobFetchError("invalid-request", "offset and maxBytes must be safe integers");
			if (maxBytes < 1 || maxBytes > 49152) throw new BlobFetchError("invalid-request", `maxBytes must be within 1..${BLOB_CHUNK_BYTES}`);
			if (offset > session.totalBytes) throw new BlobFetchError("offset-out-of-range", "offset exceeds the declared content");
			session.lastActivityMs = spec.now();
			const end = Math.min(offset + maxBytes, session.totalBytes);
			return {
				offset,
				data: await session.readSlice(offset, end - offset),
				complete: end === session.totalBytes
			};
		},
		async close(fetchId) {
			const session = sessions.get(fetchId);
			if (session === void 0) return;
			sessions.delete(fetchId);
			await release(session);
		},
		async sweep() {
			const cutoff = spec.now() - spec.fetchTtlMs;
			for (const [fetchId, session] of [...sessions]) if (session.lastActivityMs <= cutoff) {
				sessions.delete(fetchId);
				await release(session);
			}
		},
		async dispose() {
			for (const [fetchId, session] of [...sessions]) {
				sessions.delete(fetchId);
				await release(session);
			}
		}
	};
}
//#endregion
//#region src/host/approval-policy.ts
/**
* Approval policy engine (S-policy, ADR-006): the Host-owned, session-scoped
* persistent grant core. Rules are folded from the session's own log events
* (the `approval/policy` precedent: durable, replayable, dead with the
* session, never in the model transcript); matching requests are claimed on
* the `approval/request` answerer waterfall so the service's asked/decided
* audit pair still covers every programmatic grant. Fail-closed throughout:
* malformed or conflicting fold input is treated as absent, and absence is
* never treated as a grant. This module is transport-agnostic — the session
* event append path and the answerer registration are injected.
*/
const TOOL_NAME_PATTERN = /^[\x21-\x7e]{1,100}$/;
const MODE_PATTERN = /^[a-z][a-z-]{0,63}$/;
/** Mirrors the sandbox modes in packages/sandbox/sandbox/src/escalation.ts. */
const SANDBOX_MODES = /* @__PURE__ */ new Set([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
const ESCALATION_REASON = /^escalate sandbox to ([a-z-]+): /;
/** A grant was refused because the session already holds {@link MAX_ACTIVE_POLICY_RULES} active rules. */
var PolicyRuleLimitError = class extends Error {
	constructor() {
		super(`session already holds 100 active approval rules`);
		this.name = "PolicyRuleLimitError";
	}
};
function boundedId(value) {
	return typeof value === "string" && BLOB_TRANSFER_ID_PATTERN.test(value);
}
function boundedTimestamp(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/**
* Derive the honest grant class for one approval request. Escalation reasons
* narrow to the target mode; other asks fall back to the tool-level class;
* an escalation-shaped reason that does not parse yields `undefined` — the
* caller must not offer "allow same kind" when no honest class exists.
* @param toolName Tool the ask names.
* @param reason Producer-supplied reason string, when present.
* @returns The derived class, or `undefined` when none is honestly derivable.
*/
function deriveApprovalClass(toolName, reason) {
	if (!TOOL_NAME_PATTERN.test(toolName)) return void 0;
	if (reason !== void 0 && reason.startsWith("escalate sandbox to")) {
		const mode = ESCALATION_REASON.exec(reason)?.[1];
		if (mode === void 0 || !SANDBOX_MODES.has(mode)) return void 0;
		return {
			kind: "escalate",
			toolName,
			mode
		};
	}
	return {
		kind: "tool",
		toolName
	};
}
/** Parse one fold entry; malformed input returns `undefined` (fail-closed absence). */
function parseEvent(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	if (record.type === "approval/rule" && record.action === "granted") {
		if (!boundedId(record.ruleId) || record.classKind !== "escalate" && record.classKind !== "tool" || typeof record.toolName !== "string" || !TOOL_NAME_PATTERN.test(record.toolName) || record.grantedBy !== "user" && record.grantedBy !== "operator" || !boundedTimestamp(record.grantedAtMs)) return;
		if (record.classKind === "escalate") {
			if (typeof record.classMode !== "string" || !MODE_PATTERN.test(record.classMode)) return void 0;
			return {
				...record,
				classMode: record.classMode
			};
		}
		if (record.classMode !== void 0) return void 0;
		return record;
	}
	if (record.type === "approval/rule" && record.action === "revoked") {
		if (!boundedId(record.ruleId) || !boundedTimestamp(record.revokedAtMs)) return void 0;
		return record;
	}
	if (record.type === "approval/rule-applied") {
		if (typeof record.approvalId !== "string" || record.approvalId.length === 0 || !boundedId(record.ruleId) || !boundedTimestamp(record.appliedAtMs)) return;
		return record;
	}
	if (record.type === "session/budget") {
		if (typeof record.maxTotalTokens !== "number" || !Number.isSafeInteger(record.maxTotalTokens) || record.maxTotalTokens < 1 || !boundedTimestamp(record.setAtMs)) return;
		return record;
	}
}
/**
* Fold an ordered session event stream into policy state. The last valid
* action per rule id wins; malformed entries are skipped as absent.
* @param events Ordered raw log entries (oldest first).
* @returns The active rules and the current budget.
*/
function foldPolicyEvents(events) {
	const active = /* @__PURE__ */ new Map();
	let budget;
	for (const raw of events) {
		const event = parseEvent(raw);
		if (event === void 0) continue;
		if (event.type === "session/budget") {
			budget = event;
			continue;
		}
		if (event.type === "approval/rule-applied") continue;
		if (event.action === "granted") {
			const ruleClass = event.classKind === "escalate" ? {
				kind: "escalate",
				toolName: event.toolName,
				mode: event.classMode
			} : {
				kind: "tool",
				toolName: event.toolName
			};
			active.set(event.ruleId, {
				ruleId: event.ruleId,
				ruleClass,
				grantedBy: event.grantedBy,
				grantedAtMs: event.grantedAtMs
			});
		} else active.delete(event.ruleId);
	}
	const fold = { rules: [...active.values()] };
	if (budget !== void 0) fold.budget = budget;
	return fold;
}
/**
* Fold ONE raw entry into an existing fold — the incremental step the
* projection unit drives per committed event. Returns the SAME reference when
* the entry is not a (valid) policy event, so an unchanged reference stays
* `Object.is`-equal and produces zero downstream work.
* @param fold Current fold (treated as immutable; a change returns a new object).
* @param raw One raw log entry, shaped `{ type, ...payload }`.
* @returns The next fold, or `fold` itself when nothing changed.
*/
function applyPolicyEvent(fold, raw) {
	const event = parseEvent(raw);
	if (event === void 0 || event.type === "approval/rule-applied") return fold;
	if (event.type === "session/budget") return {
		rules: fold.rules,
		budget: event
	};
	if (event.action === "granted") {
		const rule = {
			ruleId: event.ruleId,
			ruleClass: event.classKind === "escalate" ? {
				kind: "escalate",
				toolName: event.toolName,
				mode: event.classMode
			} : {
				kind: "tool",
				toolName: event.toolName
			},
			grantedBy: event.grantedBy,
			grantedAtMs: event.grantedAtMs
		};
		return {
			rules: fold.rules.some((existing) => existing.ruleId === event.ruleId) ? fold.rules.map((existing) => existing.ruleId === event.ruleId ? rule : existing) : [...fold.rules, rule],
			...fold.budget === void 0 ? {} : { budget: fold.budget }
		};
	}
	if (!fold.rules.some((existing) => existing.ruleId === event.ruleId)) return fold;
	return {
		rules: fold.rules.filter((existing) => existing.ruleId !== event.ruleId),
		...fold.budget === void 0 ? {} : { budget: fold.budget }
	};
}
/**
* Find the rule auto-granting one request, if any. The request's class is
* derived with the same honesty rules as grant time.
* @param rules Active rules from {@link foldPolicyEvents} or a live engine.
* @param toolName Tool the ask names.
* @param reason Producer-supplied reason string, when present.
* @returns The matching rule, or `undefined`.
*/
function matchPolicyRule(rules, toolName, reason) {
	const derived = deriveApprovalClass(toolName, reason);
	if (derived === void 0) return void 0;
	return rules.find((rule) => {
		if (rule.ruleClass.kind !== derived.kind || rule.ruleClass.toolName !== derived.toolName) return false;
		return derived.kind === "tool" || rule.ruleClass.kind === "escalate" && rule.ruleClass.mode === derived.mode;
	});
}
/**
* Evaluate the budget against cumulative usage. All four disjoint token
* classes count toward the ceiling.
* @param budget The configured ceiling.
* @param usage Cumulative session usage.
* @returns The budget state, including exhaustion.
*/
function evaluateBudget(budget, usage) {
	const totalTokens = usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	return {
		maxTotalTokens: budget.maxTotalTokens,
		totalTokens,
		exhausted: totalTokens >= budget.maxTotalTokens
	};
}
/**
* Resolve engine behavior explicitly.
* @param request Construction request.
* @returns The fully-resolved engine spec.
*/
function resolveApprovalPolicySpec(request) {
	return {
		now: request.now ?? Date.now,
		mintRuleId: request.mintRuleId,
		append: request.append
	};
}
/**
* Create the engine for one session, seeded from the session's folded log
* prefix. Mutations serialize through one promise chain so the fold and the
* durable log can never disagree about order.
* @param spec Fully-resolved engine behavior.
* @param seedEvents Ordered raw log entries to fold before serving.
* @returns The ready engine.
*/
function createApprovalPolicyEngine(spec, seedEvents = []) {
	const state = foldPolicyEvents(seedEvents);
	const rules = new Map(state.rules.map((rule) => [rule.ruleId, rule]));
	let budget = state.budget;
	let chain = Promise.resolve();
	function enqueue(operation) {
		const run = chain.then(operation);
		chain = run.then(() => void 0, () => void 0);
		return run;
	}
	function sameClass(left, right) {
		if (left.kind !== right.kind || left.toolName !== right.toolName) return false;
		return left.kind === "tool" || right.kind === "escalate" && left.mode === right.mode;
	}
	return {
		grant(toolName, reason, grantedBy) {
			return enqueue(async () => {
				const derived = deriveApprovalClass(toolName, reason);
				if (derived === void 0) return void 0;
				const existing = [...rules.values()].find((rule) => sameClass(rule.ruleClass, derived));
				if (existing !== void 0) return existing;
				if (rules.size >= 100) throw new PolicyRuleLimitError();
				const event = {
					type: "approval/rule",
					action: "granted",
					ruleId: spec.mintRuleId(),
					classKind: derived.kind,
					toolName: derived.toolName,
					...derived.kind === "escalate" ? { classMode: derived.mode } : {},
					grantedBy,
					grantedAtMs: spec.now()
				};
				if (!boundedId(event.ruleId)) throw new Error("rule id minter produced an invalid id");
				await spec.append(event);
				const rule = {
					ruleId: event.ruleId,
					ruleClass: derived,
					grantedBy,
					grantedAtMs: event.grantedAtMs
				};
				rules.set(rule.ruleId, rule);
				return rule;
			});
		},
		revoke(ruleId) {
			return enqueue(async () => {
				if (!rules.has(ruleId)) return false;
				await spec.append({
					type: "approval/rule",
					action: "revoked",
					ruleId,
					revokedAtMs: spec.now()
				});
				rules.delete(ruleId);
				return true;
			});
		},
		claim(approvalId, toolName, reason) {
			return enqueue(async () => {
				const rule = matchPolicyRule([...rules.values()], toolName, reason);
				if (rule === void 0) return void 0;
				await spec.append({
					type: "approval/rule-applied",
					approvalId,
					ruleId: rule.ruleId,
					appliedAtMs: spec.now()
				});
				return rule;
			});
		},
		setBudget(maxTotalTokens) {
			return enqueue(async () => {
				if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1) throw new Error("session budget must be a positive safe integer");
				const event = {
					type: "session/budget",
					maxTotalTokens,
					setAtMs: spec.now()
				};
				await spec.append(event);
				budget = event;
				return event;
			});
		},
		list() {
			return [...rules.values()];
		},
		budget() {
			return budget;
		},
		observe(raw) {
			const event = parseEvent(raw);
			if (event === void 0) return;
			if (event.type === "session/budget") {
				budget = event;
				return;
			}
			if (event.type === "approval/rule-applied") return;
			if (event.action === "granted") rules.set(event.ruleId, {
				ruleId: event.ruleId,
				ruleClass: event.classKind === "escalate" ? {
					kind: "escalate",
					toolName: event.toolName,
					mode: event.classMode
				} : {
					kind: "tool",
					toolName: event.toolName
				},
				grantedBy: event.grantedBy,
				grantedAtMs: event.grantedAtMs
			});
			else rules.delete(event.ruleId);
		}
	};
}
//#endregion
//#region src/host/policy-owner.ts
/**
* Session approval-policy owner (S-policy, ADR-006): the Host-side module
* that owns the durable policy facts and every seam they cross. It declares
* the session event vocabulary (`approval/rule`, `approval/rule-applied`,
* `session/budget`), registers the `approvalPolicy` projection unit, answers
* the `approval/request` waterfall ahead of the interactive channel, and
* provides `ctx.remoteApprovalPolicy` — the face the remote-command executor
* consumes for grant/revoke/budget mutations and the send gate. The engine
* mathematics live in `approval-policy.ts`; this module binds them to one
* session store, one projection registry, and one event bus.
*/
const approvalPolicyProjectionSchema = z$1.object({
	rules: z$1.array(z$1.object({
		ruleId: z$1.string().min(1),
		classKind: z$1.enum(["escalate", "tool"]),
		toolName: z$1.string().min(1),
		classMode: z$1.string().min(1).optional(),
		grantedBy: z$1.enum(["user", "operator"]),
		grantedAtMs: z$1.number().int().nonnegative()
	}).strict()),
	budget: z$1.object({
		maxTotalTokens: z$1.number().int().positive(),
		setAtMs: z$1.number().int().nonnegative()
	}).strict().optional()
}).strict();
/** Flatten one nested engine rule into its wire-flat projection row. */
function ruleRow(rule) {
	return {
		ruleId: rule.ruleId,
		classKind: rule.ruleClass.kind,
		toolName: rule.ruleClass.toolName,
		...rule.ruleClass.kind === "escalate" ? { classMode: rule.ruleClass.mode } : {},
		grantedBy: rule.grantedBy,
		grantedAtMs: rule.grantedAtMs
	};
}
/**
* The `approvalPolicy` projection unit: folds the owner's three event types
* into the active-rules-plus-budget whole value. State is the plain-JSON
* {@link PolicyFold}; unrelated events return the same reference (zero
* downstream work per the registry contract).
*/
const approvalPolicyProjectionDefinition = {
	key: "approvalPolicy",
	schema: approvalPolicyProjectionSchema,
	init: () => ({ rules: [] }),
	apply: (state, event) => {
		if (event.type !== "approval/rule" && event.type !== "session/budget") return state;
		return applyPolicyEvent(state, {
			type: event.type,
			...event.data
		});
	},
	view: (fold) => ({
		rules: fold.rules.map(ruleRow),
		...fold.budget === void 0 ? {} : { budget: {
			maxTotalTokens: fold.budget.maxTotalTokens,
			setAtMs: fold.budget.setAtMs
		} }
	}),
	stateVersion: 1
};
/** Append one engine event to the owning session's log (type key split per the append signature). */
function appendPolicyEvent(session, event) {
	if (event.type === "approval/rule") {
		const { type: _type, ...data } = event;
		session.append("approval/rule", data);
	} else if (event.type === "approval/rule-applied") {
		const { type: _type, ...data } = event;
		session.append("approval/rule-applied", data);
	} else {
		const { type: _type, ...data } = event;
		session.append("session/budget", data);
	}
}
/**
* Find the newest still-undecided `approval/asked` audit event this request
* produced (the service appends it before dispatching the waterfall). The
* callId pairing is symmetric — a callId-bearing ask only takes its own
* call's record, a callId-less ask only a callId-less record — mirroring the
* interactive channel's join, plus a toolName guard. Absence means the
* request bypassed the service's audit path: not this answerer's question.
* @param events The session log at dispatch time.
* @param toolName The tool the pending request names.
* @param callId The exact tool call being decided, when the asker had one.
* @returns The ask's audit id, or `undefined` without a join.
*/
function findPendingApprovalId(events, toolName, callId) {
	const decided = /* @__PURE__ */ new Set();
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (event.type === "approval/decided") decided.add(String(event.data.id));
		else if (event.type === "approval/asked") {
			if (decided.has(String(event.data.id))) continue;
			if ((callId ?? null) !== (event.data.callId === void 0 ? null : String(event.data.callId))) continue;
			if (event.data.toolName !== toolName) continue;
			return String(event.data.id);
		}
	}
}
/** Structurally validate the `tokenUsage` projection value (absent or malformed reads as unmeasurable). */
function usageFrom$1(values) {
	const raw = values["tokenUsage"];
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	const counts = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (!counts(record.uncachedInputTokens) || !counts(record.outputTokens) || !counts(record.cacheReadTokens) || !counts(record.cacheWriteTokens)) return;
	return {
		uncachedInputTokens: record.uncachedInputTokens,
		outputTokens: record.outputTokens,
		cacheReadTokens: record.cacheReadTokens,
		cacheWriteTokens: record.cacheWriteTokens
	};
}
/**
* Install the policy owner: the per-session engine cache, the projection
* unit (under `sessionProjections` injection so headless assemblies stay
* unaffected), the prepended `approval/request` answerer, and the
* `ctx.remoteApprovalPolicy` service face. Everything rides the calling
* plugin's fiber — unloading host-remote retires the answerer, the unit,
* and the face together.
* @param ctx The host-remote plugin context.
*/
function installApprovalPolicyOwner(ctx) {
	const engines = /* @__PURE__ */ new WeakMap();
	/**
	* The engine for one live session, seeded from its folded log on first
	* touch. Appends go through the session log and the store's flush
	* durability barrier — a failed append or flush rejects the mutation, so
	* the engine and the durable log can never disagree.
	*/
	const engineFor = (session) => {
		let engine = engines.get(session);
		if (engine === void 0) {
			engine = createApprovalPolicyEngine(resolveApprovalPolicySpec({
				mintRuleId: () => randomBytes(16).toString("hex"),
				append: async (event) => {
					const store = ctx.get("sessions");
					if (store === void 0) throw new Error("session store is not composed");
					appendPolicyEvent(session, event);
					await store.flush(session);
				}
			}), session.events.map((entry) => ({
				type: entry.type,
				...entry.data
			})));
			engines.set(session, engine);
		}
		return engine;
	};
	const sessionFor = (sessionId) => ctx.get("sessions")?.get(sessionId);
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register(approvalPolicyProjectionDefinition);
	});
	ctx.on("approval/request", async (req, next) => {
		const session = req.agent.session;
		const engine = engineFor(session);
		const rules = engine.list();
		if (rules.length === 0) return next();
		if (matchPolicyRule(rules, req.toolName, req.reason) === void 0) return next();
		const approvalId = findPendingApprovalId(session.events, req.toolName, req.callId === void 0 ? void 0 : String(req.callId));
		if (approvalId === void 0) return next();
		let claimed;
		try {
			claimed = await engine.claim(approvalId, req.toolName, req.reason);
		} catch {
			return next();
		}
		return claimed === void 0 ? next() : "allowed-once";
	}, true);
	ctx.provide("remoteApprovalPolicy", {
		async grantForApproval(input) {
			const session = sessionFor(input.sessionId);
			if (session === void 0) return {
				ok: false,
				errorCode: "session-not-found"
			};
			let rule;
			try {
				rule = await engineFor(session).grant(input.toolName, input.reason, "user");
			} catch (error) {
				if (error instanceof PolicyRuleLimitError) return {
					ok: false,
					errorCode: "approval-rule-limit"
				};
				throw error;
			}
			if (rule === void 0) return {
				ok: false,
				errorCode: "approval-class-underivable"
			};
			return {
				ok: true,
				ruleId: rule.ruleId
			};
		},
		async revokeRule(input) {
			const session = sessionFor(input.sessionId);
			if (session === void 0) return {
				ok: false,
				errorCode: "session-not-found"
			};
			return await engineFor(session).revoke(input.ruleId) ? { ok: true } : {
				ok: false,
				errorCode: "rule-not-found"
			};
		},
		isRuleActive(input) {
			const session = sessionFor(input.sessionId);
			if (session === void 0) return false;
			return engineFor(session).list().some((rule) => rule.ruleId === input.ruleId);
		},
		async setBudget(input) {
			const session = sessionFor(input.sessionId);
			if (session === void 0) return {
				ok: false,
				errorCode: "session-not-found"
			};
			if (!Number.isSafeInteger(input.maxTotalTokens) || input.maxTotalTokens < 1) return {
				ok: false,
				errorCode: "invalid-budget"
			};
			const registry = ctx.get("sessionProjections");
			const values = registry === void 0 ? void 0 : registry.snapshot(session).values;
			if (values === void 0 || usageFrom$1(values) === void 0) return {
				ok: false,
				errorCode: "budget-meter-unavailable"
			};
			await engineFor(session).setBudget(input.maxTotalTokens);
			return { ok: true };
		},
		currentBudget(sessionId) {
			const session = sessionFor(sessionId);
			if (session === void 0) return void 0;
			return engineFor(session).budget()?.maxTotalTokens;
		},
		evaluateBudget(sessionId) {
			const session = sessionFor(sessionId);
			if (session === void 0) return void 0;
			const budget = engineFor(session).budget();
			if (budget === void 0) return void 0;
			const registry = ctx.get("sessionProjections");
			if (registry === void 0) return void 0;
			const usage = usageFrom$1(registry.snapshot(session).values);
			if (usage === void 0) return void 0;
			return evaluateBudget(budget, usage);
		}
	});
}
//#endregion
//#region src/host/read-port.ts
/** Narrow, read-only source port between ApiProxy and the mobile carrier. */
/** Stable read failure translated by the carrier without exposing ApiProxy errors. */
var RemoteReadError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "RemoteReadError";
	}
};
function titleFrom(values) {
	if (typeof values !== "object" || values === null || !("title" in values)) return void 0;
	const title = values.title;
	return typeof title === "string" && title !== "" ? title : void 0;
}
const finiteNonNegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
function numberRecord(value, required, optional = []) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	const out = {};
	for (const key of required) {
		const field = record[key];
		if (!finiteNonNegative(field)) return void 0;
		out[key] = field;
	}
	for (const key of optional) {
		const field = record[key];
		if (field === void 0) continue;
		if (!finiteNonNegative(field)) return void 0;
		out[key] = field;
	}
	return out;
}
/** Minimize one usage unit view; malformed views are dropped, never zero-filled. */
function usageUnitFrom(key, value) {
	switch (key) {
		case "tokenUsage": {
			const buckets = numberRecord(value, [
				"uncachedInputTokens",
				"outputTokens",
				"cacheReadTokens",
				"cacheWriteTokens"
			]);
			return buckets === void 0 ? void 0 : { tokenUsage: buckets };
		}
		case "contextPressure": {
			const pressure = numberRecord(value, [], [
				"pressureTokens",
				"projectedTokens",
				"contextWindow"
			]);
			return pressure === void 0 ? void 0 : { contextPressure: pressure };
		}
		case "sessionStats": {
			const stats = numberRecord(value, [
				"turns",
				"steps",
				"llmMs",
				"toolMs"
			]);
			return stats === void 0 ? void 0 : { sessionStats: stats };
		}
	}
}
function usageFrom(values) {
	if (typeof values !== "object" || values === null) return void 0;
	const record = values;
	const usage = {};
	let present = false;
	for (const key of [
		"tokenUsage",
		"contextPressure",
		"sessionStats"
	]) {
		if (!(key in record)) continue;
		const unit = usageUnitFrom(key, record[key]);
		if (unit === void 0) continue;
		Object.assign(usage, unit);
		present = true;
	}
	return present ? usage : void 0;
}
const RULE_ID_PATTERN = /^[0-9a-f]{16,64}$/;
const RULE_TOOL_PATTERN = /^[\x21-\x7e]{1,100}$/;
const RULE_MODE_PATTERN = /^[a-z][a-z-]{0,63}$/;
/**
* Minimize the `approvalPolicy` projection unit view (S-policy). A malformed
* rule row is dropped (never repaired); a malformed budget is dropped whole.
* The unit's own zod schema already validated the wire shape on the Host —
* this re-validation keeps the carrier honest against any future drift.
*/
function approvalPolicyUnitFrom(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (!Array.isArray(record.rules)) return void 0;
	const rules = [];
	for (const raw of record.rules.slice(0, 200)) {
		if (typeof raw !== "object" || raw === null) continue;
		const row = raw;
		if (typeof row.ruleId !== "string" || !RULE_ID_PATTERN.test(row.ruleId)) continue;
		if (row.classKind !== "escalate" && row.classKind !== "tool") continue;
		if (typeof row.toolName !== "string" || !RULE_TOOL_PATTERN.test(row.toolName)) continue;
		if (row.grantedBy !== "user" && row.grantedBy !== "operator") continue;
		if (!finiteNonNegative(row.grantedAtMs)) continue;
		const classMode = row.classMode;
		if (row.classKind === "escalate" && (typeof classMode !== "string" || !RULE_MODE_PATTERN.test(classMode))) continue;
		if (row.classKind === "tool" && classMode !== void 0) continue;
		rules.push({
			ruleId: row.ruleId,
			classKind: row.classKind,
			toolName: row.toolName,
			...row.classKind === "escalate" ? { classMode } : {},
			grantedBy: row.grantedBy,
			grantedAtMs: row.grantedAtMs
		});
	}
	const view = { rules };
	const budget = record.budget;
	if (budget !== void 0) {
		const bounds = numberRecord(budget, ["maxTotalTokens", "setAtMs"]);
		if (bounds !== void 0 && bounds.maxTotalTokens >= 1) view.budget = {
			maxTotalTokens: bounds.maxTotalTokens,
			setAtMs: bounds.setAtMs
		};
	}
	return view;
}
function policyFrom(values) {
	if (typeof values !== "object" || values === null) return void 0;
	const record = values;
	if (!("approvalPolicy" in record)) return void 0;
	return approvalPolicyUnitFrom(record.approvalPolicy);
}
const boundedString = (value, max = 200) => typeof value === "string" && value !== "" && value.length <= max ? value : void 0;
/** Minimize one sub-agent projection unit; malformed views are dropped. */
function subagentUnitFrom(key, value) {
	if (key === "subagent") {
		if (value === null || typeof value !== "object") return void 0;
		const record = value;
		const mode = record.mode;
		if (mode !== "one-shot" && mode !== "continuable") return void 0;
		const label = boundedString(record.label);
		if (mode === "continuable" && label === void 0) return void 0;
		return {
			mode,
			...label === void 0 ? {} : { label }
		};
	}
	const settled = numberRecord(value, ["settledMs"]);
	if (settled === void 0) return void 0;
	const view = { settledMs: settled.settledMs };
	const active = value.active;
	if (active !== void 0) {
		if (typeof active !== "object" || active === null) return void 0;
		const bounds = numberRecord(active, ["since", "through"]);
		if (bounds === void 0) return void 0;
		view.activeSinceMs = bounds.since;
		view.activeThroughMs = bounds.through;
	}
	return view;
}
function subagentFrom(values) {
	if (typeof values !== "object" || values === null) return void 0;
	const record = values;
	const view = {};
	let present = false;
	for (const key of ["subagent", "subagentTiming"]) {
		if (!(key in record)) continue;
		const unit = subagentUnitFrom(key, record[key]);
		if (unit === void 0) continue;
		Object.assign(view, unit);
		present = true;
	}
	return present ? view : void 0;
}
function workspaceLabelFrom(cwd) {
	if (cwd === void 0) return void 0;
	const label = basename(cwd.replaceAll("\\", "/"));
	return label === "" ? void 0 : label;
}
function normalizeRegistryPath(value) {
	return value.replaceAll("\\", "/").replace(/\/+$/, "");
}
/**
* Resolve the registry label for one session cwd: exact or segment-boundary
* descendant match, longest normalized root wins. Absent cwd or no match
* states nothing — the label is never guessed from the path.
*/
function projectLabelFrom(cwd, projects) {
	if (cwd === void 0 || projects.length === 0) return void 0;
	const path = normalizeRegistryPath(cwd);
	let match;
	let matchLength = -1;
	for (const entry of projects) {
		const root = normalizeRegistryPath(entry.root);
		if (root === "") continue;
		if (path !== root && !path.startsWith(`${root}/`)) continue;
		if (root.length > matchLength) {
			match = entry;
			matchLength = root.length;
		}
	}
	return match?.label;
}
/** Minimize one logged model selection; an unbounded triple states nothing. */
function modelSelectionFrom(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	const provider = boundedString(record.provider, 100);
	const model = boundedString(record.model, 200);
	if (provider === void 0 || model === void 0) return void 0;
	const reasoningEffort = boundedString(record.reasoningEffort, 100);
	return {
		provider,
		model,
		...reasoningEffort === void 0 ? {} : { reasoningEffort }
	};
}
function summaryOf(item, pendingApprovalCount, pendingInputCount, projects) {
	const title = titleFrom(item.projections?.values);
	const workspaceLabel = workspaceLabelFrom(item.cwd);
	const projectLabel = projectLabelFrom(item.cwd, projects);
	const usage = usageFrom(item.projections?.values);
	const subagent = subagentFrom(item.projections?.values);
	const parentSessionId = item.parentSessionId === void 0 ? void 0 : String(item.parentSessionId);
	const origin = item.origin === "subagent" ? "subagent" : void 0;
	const agentPreset = boundedString(item.agentPreset, 100);
	const model = modelSelectionFrom(item.model);
	return {
		sessionId: item.sessionId,
		updatedAt: item.updatedAt,
		running: item.running,
		pendingApprovalCount,
		pendingInputCount,
		...title === void 0 ? {} : { title },
		...workspaceLabel === void 0 ? {} : { workspaceLabel },
		...projectLabel === void 0 ? {} : { projectLabel },
		...usage === void 0 ? {} : { usage },
		...parentSessionId === void 0 ? {} : { parentSessionId },
		...origin === void 0 ? {} : { origin },
		...subagent === void 0 ? {} : { subagent },
		...agentPreset === void 0 ? {} : { agentPreset },
		...model === void 0 ? {} : { model }
	};
}
function unwrap(response, operation) {
	if (response.result.ok) return response.result.value;
	const { error } = response.result;
	if (error.code === "session-not-found") throw new RemoteReadError("session-not-found", error.message);
	throw new RemoteReadError("source-failed", `${operation}: ${error.message}`);
}
function request(payload) {
	return {
		rpcId: RpcId(`mobile-remote-${randomUUID()}`),
		payload
	};
}
function lastSourceSequence(entries, projectionWatermark) {
	return entries.at(-1)?.event.seq ?? projectionWatermark;
}
/**
* Close the privileged ApiProxy over a literal read-only capability object.
* The returned object contains no reference to Context, `sessions.prompt`,
* `sessions.cancel`, or `respond`.
* @param apiProxy - Internal Host gateway to minimize into read capabilities.
* @param options - Operator registry (S-project); roots stay Host-local.
* @returns A frozen capability object exposing only the minimized reads.
*/
function createRemoteProjectionReadPort(apiProxy, options = {}) {
	const projects = options.projects ?? [];
	const listAll = async () => {
		const response = await apiProxy.sessions.list(request({}));
		const approvals = apiProxy.approvalInteractions.list();
		const approvalCounts = /* @__PURE__ */ new Map();
		for (const approval of approvals) approvalCounts.set(approval.sessionId, (approvalCounts.get(approval.sessionId) ?? 0) + 1);
		const inputCounts = /* @__PURE__ */ new Map();
		for (const question of apiProxy.questionInteractions.list()) inputCounts.set(question.sessionId, (inputCounts.get(question.sessionId) ?? 0) + 1);
		const items = unwrap(response, "session.list").items;
		const blank = /* @__PURE__ */ new Set();
		return {
			rows: items.map((item) => {
				if (item.blank) blank.add(item.sessionId);
				return summaryOf(item, approvalCounts.get(item.sessionId) ?? 0, inputCounts.get(item.sessionId) ?? 0, projects);
			}),
			blank
		};
	};
	const list = async () => {
		const { rows, blank } = await listAll();
		return rows.filter((item) => !blank.has(item.sessionId));
	};
	const history = async (rawSessionId, maxMessages) => {
		const sessionId = SessionId(rawSessionId);
		const [{ rows: summaries }, response] = await Promise.all([listAll(), apiProxy.sessions.history(request({
			sessionId,
			maxMessages
		}))]);
		const summary = summaries.find((candidate) => candidate.sessionId === sessionId);
		if (summary === void 0) throw new RemoteReadError("session-not-found", `session not found: ${rawSessionId}`);
		const value = unwrap(response, "session.history");
		const projectionWatermark = value.projections?.asOfSeq ?? -1;
		const title = titleFrom(value.projections?.values) ?? summary.title;
		const usage = usageFrom(value.projections?.values) ?? summary.usage;
		const subagent = subagentFrom(value.projections?.values) ?? summary.subagent;
		const policy = policyFrom(value.projections?.values);
		return {
			entries: value.events,
			hasMore: value.hasMore,
			sourceWatermark: lastSourceSequence(value.events, projectionWatermark),
			projectionWatermark,
			running: summary.running,
			approvals: apiProxy.approvalInteractions.list(sessionId),
			pendingInputCount: apiProxy.questionInteractions.list(sessionId).length,
			...title === void 0 ? {} : { title },
			...usage === void 0 ? {} : { usage },
			...subagent === void 0 ? {} : { subagent },
			...summary.agentPreset === void 0 ? {} : { agentPreset: summary.agentPreset },
			...summary.model === void 0 ? {} : { model: summary.model },
			...policy === void 0 ? {} : { policy }
		};
	};
	const presets = async () => {
		const response = await apiProxy.agentPresets.list(request({}));
		const rows = [];
		for (const entry of unwrap(response, "agentPreset.list").presets.slice(0, 64)) {
			const id = boundedString(entry.id, 100);
			if (id === void 0) continue;
			const trust = entry.trust === "user" ? "user" : "system";
			const name = boundedString(entry.name, 100);
			const description = boundedString(entry.description, 500);
			const broken = boundedString(entry.broken, 200);
			rows.push({
				id,
				trust,
				isDefault: entry.isDefault,
				...name === void 0 ? {} : { name },
				...description === void 0 ? {} : { description },
				...broken === void 0 ? {} : { broken }
			});
		}
		return rows;
	};
	const modelCatalog = async () => {
		const fetchCatalog = async () => unwrap(await apiProxy.llm.models(request({})), "llm.models");
		let value;
		try {
			value = await fetchCatalog();
		} catch (error) {
			const detail = boundedString(error instanceof Error ? error.message : String(error), 200);
			return {
				groups: [],
				failures: [{
					providerId: "catalog",
					...detail === void 0 ? {} : { detail }
				}]
			};
		}
		const groups = [];
		for (const group of value.groups.slice(0, 32)) {
			const id = boundedString(group.id, 100);
			if (id === void 0) continue;
			const models = [];
			for (const entry of group.models.slice(0, 64)) {
				const modelId = boundedString(entry.id, 200);
				if (modelId === void 0) continue;
				const reasoningEfforts = (entry.reasoning?.efforts ?? []).map((effort) => boundedString(effort.id, 100)).filter((effort) => effort !== void 0).slice(0, 16);
				const defaultReasoningEffort = boundedString(entry.reasoning?.defaultEffort, 100);
				const name = boundedString(entry.name, 100);
				const inputModalities = entry.inputModalities?.map((modality) => boundedString(modality, 32)).filter((modality) => modality !== void 0).slice(0, 8);
				models.push({
					id: modelId,
					...name === void 0 ? {} : { name },
					reasoningEfforts,
					...defaultReasoningEffort === void 0 ? {} : { defaultReasoningEffort },
					...inputModalities === void 0 ? {} : { inputModalities }
				});
			}
			if (models.length === 0) continue;
			const name = boundedString(group.name, 100);
			groups.push({
				id,
				...name === void 0 ? {} : { name },
				models
			});
		}
		const failures = [];
		for (const failure of value.failures.slice(0, 32)) {
			const providerId = boundedString(failure.id, 100);
			if (providerId === void 0) continue;
			const detail = boundedString(failure.message, 200);
			failures.push({
				providerId,
				...detail === void 0 ? {} : { detail }
			});
		}
		return {
			groups,
			failures
		};
	};
	const watch = async function* (rawSessionId, signal) {
		const sessionId = SessionId(rawSessionId);
		for await (const envelope of apiProxy.events.mux(request({}), signal)) {
			const frame = envelope.payload;
			if ((frame.type === "question/requested" || frame.type === "question/resolved") && frame.sessionId === sessionId) {
				yield {
					type: "question/attention",
					sessionId,
					interactionId: frame.type === "question/requested" ? envelope.rpcId : frame.questionRpcId,
					pendingCount: apiProxy.questionInteractions.list(sessionId).length
				};
				continue;
			}
			if ((frame.type === "session/subscribed" || frame.type === "session/event" || frame.type === "session/projection" || frame.type === "approval/requested" || frame.type === "approval/resolved") && frame.sessionId === sessionId) yield frame;
		}
	};
	const sessionCwd = async (rawSessionId) => {
		return unwrap(await apiProxy.sessions.list(request({})), "session.list").items.find((candidate) => String(candidate.sessionId) === rawSessionId)?.cwd;
	};
	const attachmentRef = async (rawSessionId, rawAttachmentId) => {
		try {
			const result = await apiProxy.sessions.attachmentRef(request({
				sessionId: SessionId(rawSessionId),
				attachmentId: AttachmentId(rawAttachmentId)
			}));
			return result.result.ok ? result.result.value.attachment : void 0;
		} catch {
			return;
		}
	};
	const existingDirectory = (path) => {
		try {
			return existsSync(path) && statSync(path).isDirectory();
		} catch {
			return false;
		}
	};
	const ensureKnownParents = async () => {
		const adopt = async (path) => {
			if (!existingDirectory(path)) return;
			try {
				await apiProxy.workspace.create(request({ path }));
			} catch {}
		};
		try {
			const described = await apiProxy.host.describe(request({}));
			if (described.result.ok) await adopt(described.result.value.cwd);
		} catch {}
		for (const project of projects) await adopt(project.root);
	};
	const workspaces = async () => {
		try {
			await ensureKnownParents();
		} catch {}
		let items;
		try {
			items = unwrap(await apiProxy.workspace.list(request({})), "workspace.list").items;
		} catch {
			return [];
		}
		const rows = [];
		for (const item of items.slice(0, 64)) {
			const workspaceId = boundedString(String(item.workspaceId), 100);
			if (workspaceId === void 0) continue;
			const fromProject = projectLabelFrom(item.path, projects);
			const title = boundedString(item.title, 100);
			const base = workspaceLabelFrom(item.path);
			const label = fromProject ?? title ?? base;
			if (label === void 0) continue;
			rows.push({
				workspaceId,
				label
			});
		}
		return rows;
	};
	return Object.freeze({
		list,
		history,
		watch,
		sessionCwd,
		presets,
		modelCatalog,
		attachmentRef,
		workspaces
	});
}
//#endregion
//#region src/host/security.ts
/** Host security owner loaded from the shared Rust Node-API addon. */
const REMOTE_SECURITY_ADDON_PACKAGES = /* @__PURE__ */ new Map([["win32-x64", "@w2112515/dsh-remote-security-core-win32-x64"]]);
var SecurityOwner = class {
	store;
	#invitations = /* @__PURE__ */ new Map();
	#pending = /* @__PURE__ */ new Map();
	constructor(store) {
		this.store = store;
	}
	hostPublicKey() {
		return Buffer.from(this.store.hostPublicKey);
	}
	createInvitation(nowMs, lifetimeMs, capabilities, endpointHost, endpointPort) {
		if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid invitation timestamp");
		if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new Error("invalid invitation lifetime");
		if (endpointHost.length === 0 || endpointHost.length > 253) throw new Error("invalid invitation endpoint");
		if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535) throw new Error("invalid invitation endpoint port");
		if (!/^(0|[1-9]\d{0,19})$/.test(capabilities) || BigInt(capabilities) > 18446744073709551615n) throw new Error("invalid invitation capabilities");
		const native = this.store.createInvitation(nowMs, lifetimeMs, capabilities);
		if (native.capabilities !== capabilities) throw new Error("security addon changed invitation capabilities");
		const invitation = {
			invitationId: Buffer.from(native.id),
			invitationPsk: Buffer.from(native.psk),
			hostPublicKey: Buffer.from(native.hostPublicKey),
			expiresAtMs: native.expiresAtMs,
			capabilities: native.capabilities,
			endpointHost,
			endpointPort
		};
		native.psk.fill(0);
		this.#invitations.set(invitationKey(invitation.invitationId), {
			invitationId: Buffer.from(invitation.invitationId),
			hostPublicKey: Buffer.from(invitation.hostPublicKey),
			expiresAtMs: invitation.expiresAtMs,
			capabilities: invitation.capabilities
		});
		return invitation;
	}
	pairingResponder(invitationId, presentedHostPublicKey, nowMs) {
		const invitation = this.#invitations.get(invitationKey(invitationId));
		if (invitation === void 0) throw new Error("pairing invitation is unavailable");
		if (presentedHostPublicKey.length !== invitation.hostPublicKey.length || !timingSafeEqual(presentedHostPublicKey, invitation.hostPublicKey)) throw new Error("pairing Host identity does not match");
		if (BigInt(nowMs) >= BigInt(invitation.expiresAtMs)) throw new Error("pairing invitation expired");
		return wrapHandshake(this.store.pairingResponder(Buffer.from(invitation.invitationId), nowMs, pairingPrologue(invitation)));
	}
	stagePairing(invitationId, devicePublicKey, deviceName, verificationCode, nowMs) {
		const key = invitationKey(invitationId);
		const invitation = this.#invitations.get(key);
		if (invitation === void 0) throw new Error("pairing invitation is unavailable");
		const boundedName = deviceName.trim();
		if (boundedName.length === 0 || Array.from(boundedName).length > 80) throw new Error("invalid device name");
		if (!/^\d{8}$/.test(verificationCode)) throw new Error("invalid pairing verification code");
		if (this.#pending.has(key)) throw new Error("pairing already awaits confirmation");
		this.store.stagePairing(Buffer.from(invitationId), Buffer.from(devicePublicKey), nowMs);
		let resolveDecision;
		const decision = new Promise((resolve) => {
			resolveDecision = resolve;
		});
		this.#pending.set(key, {
			view: {
				invitationId: Buffer.from(invitationId),
				devicePublicKey: Buffer.from(devicePublicKey),
				deviceName: boundedName,
				verificationCode,
				expiresAtMs: invitation.expiresAtMs,
				capabilities: invitation.capabilities
			},
			resolve: resolveDecision,
			decision
		});
		return decision;
	}
	pendingPairings() {
		return [...this.#pending.values()].map(({ view }) => clonePending(view));
	}
	confirmPairing(invitationId, nowMs) {
		const key = invitationKey(invitationId);
		const pending = this.#pending.get(key);
		if (pending === void 0) throw new Error("pairing is not awaiting confirmation");
		const authorization = cloneAuthorization(this.store.confirmPairing(Buffer.from(invitationId), pending.view.deviceName, pending.view.capabilities, nowMs));
		if (authorization.capabilities !== pending.view.capabilities) throw new Error("security addon changed confirmed capabilities");
		this.#pending.delete(key);
		this.#invitations.delete(key);
		pending.resolve("confirmed");
		return authorization;
	}
	rejectPairing(invitationId) {
		const key = invitationKey(invitationId);
		const pending = this.#pending.get(key);
		this.store.cancelInvitation(Buffer.from(invitationId));
		this.#pending.delete(key);
		this.#invitations.delete(key);
		pending?.resolve("rejected");
	}
	listDevices() {
		return this.store.listDevices().map(cloneAuthorization);
	}
	revoke(deviceId, nowMs) {
		return this.store.revoke(Buffer.from(deviceId), nowMs);
	}
	connectionResponder(canonicalPrologue) {
		return wrapHandshake(this.store.connectionResponder(canonicalPrologue));
	}
	authorizeCapabilities(devicePublicKey, requiredCapabilities) {
		const result = this.store.authorizeCapabilities(devicePublicKey, requiredCapabilities);
		if (result.decision !== "allowed") return { decision: result.decision };
		if (result.deviceId === void 0 || result.deviceId.length !== 16) throw new Error("security addon omitted the canonical allowed device id");
		if (result.authorityEpoch === void 0) throw new Error("security addon omitted the allowed authority epoch");
		if (result.grantedCapabilities === void 0 || !/^(0|[1-9]\d*)$/.test(result.grantedCapabilities) || BigInt(result.grantedCapabilities) > 18446744073709551615n) throw new Error("security addon omitted the allowed capability grant");
		return {
			decision: "allowed",
			deviceId: Buffer.from(result.deviceId),
			grantedCapabilities: result.grantedCapabilities,
			authorityEpoch: result.authorityEpoch
		};
	}
};
function wrapHandshake(handshake) {
	return {
		read: (message) => Buffer.from(handshake.read(message)),
		write: (payload) => Buffer.from(handshake.write(payload)),
		finished: () => handshake.finished,
		peerPublicKey: () => Buffer.from(handshake.peerPublicKey()),
		verificationCode: () => handshake.verificationCode(),
		finishTransport: () => {
			const transport = handshake.finishTransport();
			return {
				encrypt: (plaintext) => Buffer.from(transport.encrypt(plaintext)),
				decrypt: (ciphertext) => Buffer.from(transport.decrypt(ciphertext))
			};
		}
	};
}
function invitationKey(invitationId) {
	if (invitationId.length !== 16) throw new Error("invitation id must be 16 bytes");
	return invitationId.toString("hex");
}
function clonePending(value) {
	return {
		...value,
		invitationId: Buffer.from(value.invitationId),
		devicePublicKey: Buffer.from(value.devicePublicKey)
	};
}
function cloneAuthorization(value) {
	return {
		...value,
		deviceId: Buffer.from(value.deviceId),
		publicKey: Buffer.from(value.publicKey)
	};
}
/**
* Load the shared native security owner and fail before the listener binds when
* the addon or protected Host store cannot be opened.
* @param addonPath - Optional absolute or process-relative Node-API addon override.
* @param storePath - Absolute or process-relative protected Host-state path.
* @param loadAddon - Test hook receiving the resolved path or fixed platform package.
* @returns A capability-minimized security owner with no private-key accessor.
*/
function loadRemoteSecurityOwner(addonPath, storePath, loadAddon = defaultAddonLoader(addonPath)) {
	const addon = nativeSecurityAddon(loadAddon(addonPath === void 0 ? resolveBundledSecurityAddon() : resolve(addonPath)));
	if (typeof addon.NodeHostSecurityStore?.loadOrCreate !== "function") throw new Error("security addon does not expose NodeHostSecurityStore");
	const store = addon.NodeHostSecurityStore.loadOrCreate(resolve(storePath));
	if (typeof store.authorizeCapabilities !== "function") throw new Error("security addon does not expose exact capability authorization");
	if (typeof store.createInvitation !== "function" || typeof store.confirmPairing !== "function") throw new Error("security addon does not expose exact capability pairing");
	return new SecurityOwner(store);
}
function defaultAddonLoader(addonPath) {
	const packageRequire = createRequire(import.meta.url);
	if (addonPath !== void 0) return (specifier) => packageRequire(specifier);
	const deploymentRequire = createRequire(resolve("package.json"));
	return (specifier) => {
		let modulePath;
		try {
			modulePath = packageRequire.resolve(specifier);
		} catch (error) {
			if (!isMissingPackage(error, specifier)) throw error;
			modulePath = deploymentRequire.resolve(specifier);
		}
		return packageRequire(modulePath);
	};
}
function isMissingPackage(error, specifier) {
	return error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND" && error.message.includes(specifier);
}
function remoteSecurityAddonPackage(platform, arch) {
	const host = `${platform}-${arch}`;
	const packageName = REMOTE_SECURITY_ADDON_PACKAGES.get(host);
	if (packageName === void 0) throw new Error(`DSH Remote has no reviewed security addon for ${host}`);
	return packageName;
}
/**
* Distinguish a recoverable security-owner absence from a fail-closed defect.
* @param error - rejection from {@link loadRemoteSecurityOwner}.
* @param addonPath - the same override passed to the loader.
*/
function classifyRemoteSecurityLoadFailure(error, addonPath) {
	if ((error instanceof Error ? error.message : String(error)).startsWith("DSH Remote has no reviewed security addon for ")) return "unsupported-platform";
	if (error instanceof Error && isMissingPackage(error, remoteSecurityAddonSpecifier(addonPath))) return "missing-addon";
}
function remoteSecurityAddonSpecifier(addonPath) {
	return addonPath === void 0 ? resolveBundledSecurityAddon() : resolve(addonPath);
}
/** Prefer the Windows x64 files shipped in this package; otherwise the platform package name. */
function resolveBundledSecurityAddon() {
	if (`${process.platform}-${process.arch}` === "win32-x64") for (const spec of [new URL("../native/win32-x64/index.mjs", import.meta.url), new URL("../../native/win32-x64/index.mjs", import.meta.url)]) {
		const pathname = fileURLToPath(spec);
		if (existsSync(pathname)) return pathname;
	}
	return remoteSecurityAddonPackage(process.platform, process.arch);
}
function nativeSecurityAddon(value) {
	if (typeof value !== "object" || value === null) return {};
	const module = value;
	if (typeof module.default !== "object" || module.default === null) return module;
	return module.default;
}
const PROLOGUE_LABEL = Buffer.from("dsh-remote/connect/v1", "utf8");
const PAIRING_PROLOGUE_LABEL = Buffer.from("dsh-remote/pair/v1", "utf8");
function boundedField(value) {
	if (value.length > 65535) throw new Error("secure prologue field exceeds 65535 bytes");
	const length = Buffer.allocUnsafe(2);
	length.writeUInt16BE(value.length);
	return Buffer.concat([length, value]);
}
/**
* Encode the unambiguous Noise IK prologue shared by the Android and Host cores.
* @param hostPublicKey - Exact Host key pinned during pairing.
* @param connectionId - Fresh client-selected connection identity.
* @returns Canonical bytes binding protocol, Host, connection, and read-only capabilities.
*/
function connectionPrologue(hostPublicKey, connectionId) {
	if (hostPublicKey.length !== 32) throw new Error("Host public key must be 32 bytes");
	const connection = Buffer.from(connectionId, "utf8");
	if (connection.length === 0 || connection.length > 128) throw new Error("invalid secure connection id");
	const capabilities = Buffer.allocUnsafe(8);
	capabilities.writeBigUInt64BE(3n);
	return Buffer.concat([
		boundedField(PROLOGUE_LABEL),
		boundedField(hostPublicKey),
		boundedField(connection),
		boundedField(capabilities)
	]);
}
/**
* Canonical XXpsk3 transcript binding shared with Android.
* @param invitation - exact cached invitation fields bound into the transcript.
* @returns canonical length-prefixed pairing prologue.
*/
function pairingPrologue(invitation) {
	if (invitation.hostPublicKey.length !== 32) throw new Error("Host public key must be 32 bytes");
	if (invitation.invitationId.length !== 16) throw new Error("invitation id must be 16 bytes");
	const expiresAt = Buffer.allocUnsafe(8);
	expiresAt.writeBigUInt64BE(BigInt(invitation.expiresAtMs));
	const capabilities = Buffer.allocUnsafe(8);
	capabilities.writeBigUInt64BE(BigInt(invitation.capabilities));
	return Buffer.concat([
		boundedField(PAIRING_PROLOGUE_LABEL),
		boundedField(invitation.hostPublicKey),
		boundedField(invitation.invitationId),
		boundedField(expiresAt),
		boundedField(capabilities)
	]);
}
//#endregion
//#region src/host/cursor.ts
/** New retention cannot evict any attached generation within the global bound. */
var ProjectionGenerationCapacityError = class extends Error {
	constructor() {
		super("retained projection generation capacity is exhausted");
		this.name = "ProjectionGenerationCapacityError";
	}
};
function domainsEqual(left, right) {
	return left.sessionId === right.sessionId && left.devicePublicKey === right.devicePublicKey && left.authorityEpoch === right.authorityEpoch && left.projectionVersion === right.projectionVersion;
}
/** One retained stream generation with a serialized append/attach owner. */
var RetainedProjectionGeneration = class {
	streamId;
	domain;
	abort;
	options;
	remove;
	#frames = [];
	#retainedJsonBytes = 0;
	#latestSequence = 0n;
	#delivery;
	#expiry;
	#serial = Promise.resolve();
	#disposed = false;
	constructor(streamId, domain, abort, options, remove, delivery) {
		this.streamId = streamId;
		this.domain = domain;
		this.abort = abort;
		this.options = options;
		this.remove = remove;
		this.#delivery = delivery;
	}
	/** Highest sequence assigned in this generation, including evicted events. */
	get latestSequence() {
		return this.#latestSequence;
	}
	/** Whether this generation currently owns a live delivery. */
	get attached() {
		return this.#delivery !== void 0;
	}
	/**
	* Append, retain, and deliver one projected event in generation order.
	* @param payload - Minimized projected-event fields excluding generation coordinates.
	*/
	append(payload) {
		return this.#enqueue(() => {
			if (this.#disposed) return;
			const sequence = ++this.#latestSequence;
			const frame = { event: {
				stream_id: this.streamId,
				projection_version: this.domain.projectionVersion,
				sequence: String(sequence),
				session_id: this.domain.sessionId,
				...payload
			} };
			const retained = {
				sequence,
				frame,
				jsonBytes: Buffer.byteLength(JSON.stringify(frame), "utf8")
			};
			this.#frames.push(retained);
			this.#retainedJsonBytes += retained.jsonBytes;
			while (this.#frames.length > this.options.maxEvents || this.#retainedJsonBytes > this.options.maxJsonBytes) {
				const removed = this.#frames.shift();
				if (removed !== void 0) this.#retainedJsonBytes -= removed.jsonBytes;
			}
			const delivery = this.#delivery;
			if (delivery !== void 0) this.#deliver(delivery, frame);
		});
	}
	/**
	* Attach one delivery owner, emit acceptance, and replay a contiguous retained suffix.
	* @param delivery - Authenticated connection that becomes the sole delivery owner.
	* @param highestContiguousSequence - Last sequence already applied by the client.
	* @returns A rejection reason, or `undefined` after acceptance and replay.
	*/
	resume(delivery, highestContiguousSequence) {
		let rejection;
		return this.#enqueue(() => {
			if (this.#disposed) {
				rejection = "generation-unavailable";
				return;
			}
			if (!delivery.active()) {
				rejection = "generation-unavailable";
				return;
			}
			if (highestContiguousSequence > this.#latestSequence) {
				rejection = "cursor-ahead";
				return;
			}
			const oldest = this.#frames[0]?.sequence;
			if (highestContiguousSequence < this.#latestSequence && (oldest === void 0 || highestContiguousSequence + 1n < oldest)) {
				rejection = "cursor-too-old";
				return;
			}
			this.#delivery = delivery;
			this.#clearExpiry();
			const latestSequence = this.#latestSequence;
			if (!this.#deliver(delivery, { resume_accepted: {
				stream_id: this.streamId,
				projection_version: this.domain.projectionVersion,
				resumed_after_sequence: String(highestContiguousSequence),
				latest_sequence: String(latestSequence)
			} })) {
				rejection = "generation-unavailable";
				return;
			}
			for (const retained of this.#frames) if (retained.sequence > highestContiguousSequence && retained.sequence <= latestSequence) {
				if (!this.#deliver(delivery, retained.frame)) {
					rejection = "generation-unavailable";
					return;
				}
			}
		}).then(() => rejection);
	}
	/**
	* Detach only the named delivery owner and begin the offline retention TTL.
	* @param delivery - Connection losing ownership; stale owners cannot detach a replacement.
	*/
	detach(delivery) {
		return this.#enqueue(() => {
			if (this.#disposed || this.#delivery !== delivery) return;
			this.#delivery = void 0;
			this.#startExpiry();
		});
	}
	/**
	* Serialize a terminal frame after prior events, then abort and clear the generation.
	* @param frame - Retryable terminal error delivered before disposal when attached.
	*/
	invalidate(frame) {
		return this.#enqueue(() => {
			if (this.#disposed) return;
			this.#delivery?.write(frame);
			this.dispose();
		});
	}
	/** Abort the source watcher, clear retained JSON, and remove this generation. */
	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#clearExpiry();
		this.#delivery = void 0;
		this.#frames.length = 0;
		this.#retainedJsonBytes = 0;
		this.abort.abort();
		this.remove(this);
	}
	#enqueue(operation) {
		const next = this.#serial.then(operation);
		this.#serial = next.catch(() => {});
		return next;
	}
	#clearExpiry() {
		if (this.#expiry === void 0) return;
		clearTimeout(this.#expiry);
		this.#expiry = void 0;
	}
	#startExpiry() {
		this.#clearExpiry();
		this.#expiry = setTimeout(() => {
			this.dispose();
		}, this.options.detachedTtlMs);
		this.#expiry.unref();
	}
	#deliver(delivery, frame) {
		if (!delivery.active()) {
			if (this.#delivery === delivery) {
				this.#delivery = void 0;
				this.#startExpiry();
			}
			return false;
		}
		if (!delivery.write(frame)) {
			if (this.#delivery === delivery) {
				this.#delivery = void 0;
				this.#startExpiry();
			}
			delivery.backpressure();
			return false;
		}
		return true;
	}
};
/** Process-local owner for all resumable Remote projection generations. */
var RetainedProjectionCursorStore = class {
	options;
	#generations = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
	}
	/**
	* Create an attached generation around an already-open source watcher.
	* @param streamId - Fresh unpredictable generation identity.
	* @param domain - Session, authenticated authority, and projection binding.
	* @param abort - Controller that owns the source watcher.
	* @param delivery - Initial authenticated delivery owner.
	* @returns The new retained generation.
	*/
	create(streamId, domain, abort, delivery) {
		for (const generation of [...this.#generations.values()]) if (domainsEqual(generation.domain, domain)) generation.dispose();
		while (this.#generations.size >= this.options.maxGenerations) {
			const detached = [...this.#generations.values()].find((generation) => !generation.attached);
			if (detached === void 0) throw new ProjectionGenerationCapacityError();
			detached.dispose();
		}
		const generation = new RetainedProjectionGeneration(streamId, domain, abort, this.options, (current) => {
			if (this.#generations.get(current.streamId) === current) this.#generations.delete(current.streamId);
		}, delivery);
		this.#generations.set(streamId, generation);
		return generation;
	}
	/**
	* Validate the complete resume domain, then atomically attach and replay.
	* @param domain - Current authenticated connection and requested Session domain.
	* @param cursor - Retained generation and last contiguous client sequence.
	* @param delivery - Authenticated connection requesting ownership.
	* @returns Acceptance with the generation, or a stable snapshot-required reason.
	*/
	async resume(domain, cursor, delivery) {
		const generation = this.#generations.get(cursor.streamId);
		if (generation === void 0) return {
			accepted: false,
			reason: "generation-unavailable"
		};
		if (cursor.projectionVersion !== domain.projectionVersion || !domainsEqual(generation.domain, domain)) return {
			accepted: false,
			reason: "domain-changed"
		};
		const rejection = await generation.resume(delivery, cursor.highestContiguousSequence);
		return rejection === void 0 ? {
			accepted: true,
			generation
		} : {
			accepted: false,
			reason: rejection
		};
	}
	/**
	* Abort and forget generations whose authenticated authority is no longer current.
	* @param isCurrent - Reauthorization predicate over each retained domain.
	*/
	fenceAuthorization(isCurrent) {
		for (const generation of [...this.#generations.values()]) if (!isCurrent(generation.domain)) generation.dispose();
	}
	/** Abort every source watcher and clear all retained generations. */
	stop() {
		for (const generation of [...this.#generations.values()]) generation.dispose();
		this.#generations.clear();
	}
};
//#endregion
//#region src/host/projection.ts
/** Convert one minimized policy rule into its wire row. */
function approvalRuleWire(rule) {
	return {
		rule_id: rule.ruleId,
		class_kind: rule.classKind,
		tool_name: rule.toolName,
		...rule.classMode === void 0 ? {} : { class_mode: rule.classMode },
		granted_by: rule.grantedBy,
		granted_at_ms: String(rule.grantedAtMs)
	};
}
/**
* Convert the minimized policy view into the wire fold. `exhausted` is the
* owner's admission decision at emission time (S-policy): the fold itself
* never stores it, so the carrier asserts it alongside the ceiling.
*/
function policyChangedWire(view, exhausted) {
	return {
		rules: view.rules.map(approvalRuleWire),
		...view.budget === void 0 ? {} : { budget: {
			max_total_tokens: String(view.budget.maxTotalTokens),
			exhausted
		} }
	};
}
/**
* Project one live `approvalPolicy` projection frame into the retained
* stream. The frame's view is re-validated through the read-port minimizer,
* so a malformed fold is dropped instead of crossing the carrier.
* @param frame - ApiProxy session/projection frame for the policy key.
* @param exhausted - The owner's current budget admission decision.
* @returns A policy_changed payload carrying the whole fold, or null.
*/
function projectPolicyFrame(frame, exhausted) {
	if (frame.key !== "approvalPolicy") return null;
	const view = approvalPolicyUnitFrom(frame.value);
	if (view === void 0) return null;
	return {
		event_id: `source-projection-approvalPolicy-${frame.seq}`,
		source_sequence: String(frame.seq),
		policy_changed: policyChangedWire(view, exhausted)
	};
}
/** Convert the read-port's minimized model selection into the wire shape. */
function modelSelectionWire(selection) {
	if (selection === void 0) return void 0;
	return {
		provider: selection.provider,
		model: selection.model,
		...selection.reasoningEffort === void 0 ? {} : { reasoning_effort: selection.reasoningEffort }
	};
}
/**
* Convert the read-port's minimized sub-agent view into the wire shape.
* Half absence is preserved: a live frame carries only the half that changed.
*/
function subagentViewWire(view) {
	if (view === void 0) return void 0;
	const wire = {};
	if (view.mode !== void 0) wire.mode = view.mode;
	if (view.label !== void 0) wire.label = view.label;
	if (view.settledMs !== void 0) wire.settled_ms = String(view.settledMs);
	if (view.activeSinceMs !== void 0) wire.active_since_ms = String(view.activeSinceMs);
	if (view.activeThroughMs !== void 0) wire.active_through_ms = String(view.activeThroughMs);
	return wire;
}
/** Session-projection keys that carry sub-agent unit views. */
const SUBAGENT_PROJECTION_KEYS = ["subagent", "subagentTiming"];
function isSubagentProjectionKey(key) {
	return SUBAGENT_PROJECTION_KEYS.includes(key);
}
/**
* Project one live sub-agent-unit projection frame into the retained stream.
* The frame's view is re-validated through the read-port minimizer; the
* identity unit's null sentinel (undistinguished missing-or-malformed) is
* dropped rather than crossing as a fact.
*/
function projectSubagentFrame(frame) {
	if (!isSubagentProjectionKey(frame.key)) return null;
	const unit = subagentUnitFrom(frame.key, frame.value);
	if (unit === void 0) return null;
	const subagent = subagentViewWire(unit);
	if (subagent === void 0) return null;
	return {
		event_id: `source-projection-${frame.key}-${frame.seq}`,
		source_sequence: String(frame.seq),
		subagent_changed: { subagent }
	};
}
/**
* Convert the read-port's minimized usage views into the wire shape. Unit
* absence is preserved: an unloaded projection unit never becomes zeros.
* @param usage - Minimized per-unit usage views, if the Host provides any.
* @returns The proto-shaped usage message, or undefined when no unit exists.
*/
function sessionUsageWire(usage) {
	if (usage === void 0) return void 0;
	const wire = {};
	if (usage.tokenUsage !== void 0) wire.token_usage = {
		uncached_input_tokens: String(usage.tokenUsage.uncachedInputTokens),
		output_tokens: String(usage.tokenUsage.outputTokens),
		cache_read_tokens: String(usage.tokenUsage.cacheReadTokens),
		cache_write_tokens: String(usage.tokenUsage.cacheWriteTokens)
	};
	if (usage.contextPressure !== void 0) {
		const pressure = usage.contextPressure;
		wire.context_pressure = {
			...pressure.pressureTokens === void 0 ? {} : { pressure_tokens: String(pressure.pressureTokens) },
			...pressure.projectedTokens === void 0 ? {} : { projected_tokens: String(pressure.projectedTokens) },
			...pressure.contextWindow === void 0 ? {} : { context_window: String(pressure.contextWindow) }
		};
	}
	if (usage.sessionStats !== void 0) wire.stats = {
		turns: String(usage.sessionStats.turns),
		steps: String(usage.sessionStats.steps),
		llm_ms: String(usage.sessionStats.llmMs),
		tool_ms: String(usage.sessionStats.toolMs)
	};
	return wire;
}
/** Session-projection keys that carry usage unit views. */
const USAGE_PROJECTION_KEYS = [
	"tokenUsage",
	"contextPressure",
	"sessionStats"
];
function isUsageProjectionKey(key) {
	return USAGE_PROJECTION_KEYS.includes(key);
}
/**
* Project one live usage-unit projection frame into the retained stream.
* The frame's view is re-validated through the read-port minimizer, so a
* malformed unit view is dropped instead of crossing the carrier.
* @param frame - ApiProxy session/projection frame for a usage key.
* @returns A usage_changed payload carrying exactly the changed unit, or null.
*/
function projectUsageFrame(frame) {
	if (!isUsageProjectionKey(frame.key)) return null;
	const unit = usageUnitFrom(frame.key, frame.value);
	if (unit === void 0) return null;
	const usage = sessionUsageWire(unit);
	if (usage === void 0) return null;
	return {
		event_id: `source-projection-${frame.key}-${frame.seq}`,
		source_sequence: String(frame.seq),
		usage_changed: usage
	};
}
function textOf(content) {
	return content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
/**
* Extract the image blocks of one user message into wire references (S-blob).
* A block whose attachment record is malformed states nothing and is dropped
* rather than repaired; absence of the whole field (not an empty list) marks
* a text-only message.
* @param content - User-message content blocks from the session log.
* @returns Wire references, or `undefined` when the message carries no valid image.
*/
function imageAttachmentsWire(content) {
	const wires = [];
	for (const block of content) {
		if (block.type !== "image") continue;
		const ref = block.attachment;
		if (typeof ref !== "object" || ref === null) continue;
		const record = ref;
		const id = record.attachmentId;
		const mediaType = record.mediaType;
		const bytes = record.bytes;
		if (typeof id !== "string" || id === "" || id.length > 128) continue;
		if (typeof mediaType !== "string" || mediaType === "" || mediaType.length > 64) continue;
		if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) continue;
		const width = record.width;
		const height = record.height;
		if (width !== void 0 && (typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0)) continue;
		if (height !== void 0 && (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0)) continue;
		const name = record.name;
		if (name !== void 0 && typeof name !== "string") continue;
		wires.push({
			attachment_id: id,
			media_type: mediaType,
			bytes: String(bytes),
			...width === void 0 ? {} : { width },
			...height === void 0 ? {} : { height },
			...name === void 0 || name === "" ? {} : { name: boundedText(name, 200) }
		});
	}
	return wires.length === 0 ? void 0 : wires;
}
function boundedJson(value, maxChars) {
	let text;
	try {
		text = JSON.stringify(value, void 0, 2);
	} catch {
		return {
			text: "",
			truncated: true
		};
	}
	if (text.length <= maxChars) return {
		text,
		truncated: false
	};
	return {
		text: `${text.slice(0, Math.max(0, maxChars - 1))}…`,
		truncated: true
	};
}
function boundedText(value, maxChars) {
	return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
/**
* Minimize one Host approval entry without inferring missing policy facts.
* @param interaction - Current Host-owned live approval interaction.
* @param maxChars - Per-field character bound for mobile projection.
* @returns Bounded protocol approval entry.
*/
function projectApprovalInteraction(interaction, maxChars) {
	const sameKind = deriveApprovalClass(interaction.toolName, interaction.reason) !== void 0;
	const common = {
		approval_id: interaction.approvalId,
		revision: interaction.revision,
		session_id: interaction.sessionId,
		tool_name: boundedText(interaction.toolName, maxChars),
		call_id: interaction.callId ?? "",
		reason: boundedText(interaction.reason ?? "", maxChars),
		workspace_label: boundedText(interaction.workspaceLabel ?? "", maxChars),
		allowed_decisions: [
			"APPROVAL_DECISION_ALLOW_ONCE",
			"APPROVAL_DECISION_DENY",
			...sameKind ? ["APPROVAL_DECISION_ALLOW_SAME_KIND"] : []
		]
	};
	if (interaction.presentation.availability === "unavailable") return {
		...common,
		presentation_unavailable: { reason: interaction.presentation.reason }
	};
	const value = interaction.presentation.value;
	const risk = {
		routine: "APPROVAL_RISK_ROUTINE",
		sensitive: "APPROVAL_RISK_SENSITIVE",
		destructive: "APPROVAL_RISK_DESTRUCTIVE"
	}[value.risk];
	return {
		...common,
		presentation: {
			summary: boundedText(value.summary, maxChars),
			risk,
			resources: value.resources.slice(0, 8).map((resource) => boundedText(resource, maxChars)),
			consequence: boundedText(value.consequence, maxChars),
			source: boundedText(value.source, maxChars)
		}
	};
}
/**
* Project one live approval lifecycle frame into the retained Remote stream.
* @param frame - ApiProxy approval request or resolution frame.
* @param maxChars - Per-field character bound for mobile projection.
* @returns Retained-stream event payload.
*/
function projectApprovalFrame(frame, maxChars) {
	const common = {
		event_id: `approval-${frame.approvalId}-${frame.revision}`,
		source_sequence: "0"
	};
	if (frame.type === "approval/requested") return {
		...common,
		approval_changed: {
			approval_id: frame.approvalId,
			revision: frame.revision,
			pending: projectApprovalInteraction({
				revision: frame.revision,
				sessionId: frame.sessionId,
				approvalId: frame.approvalId,
				toolName: frame.toolName,
				...frame.callId === void 0 ? {} : { callId: frame.callId },
				...frame.reason === void 0 ? {} : { reason: frame.reason },
				...frame.workspaceLabel === void 0 ? {} : { workspaceLabel: frame.workspaceLabel },
				allowedOutcomes: ["allowed-once", "rejected"],
				presentation: frame.presentation
			}, maxChars)
		}
	};
	const decision = frame.outcome === "allowed-once" ? "APPROVAL_DECISION_ALLOW_ONCE" : frame.outcome === "rejected" ? "APPROVAL_DECISION_DENY" : "APPROVAL_DECISION_UNSPECIFIED";
	return {
		...common,
		approval_changed: {
			approval_id: frame.approvalId,
			revision: frame.revision,
			resolved: {
				decision,
				terminal: frame.outcome
			}
		}
	};
}
/**
* Project one content-free user-input attention count into the retained stream.
* @param frame - Host-owned interaction identity and current pending count.
* @returns A minimized projected event containing no question content or answer authority.
*/
function projectInputAttentionFrame(frame) {
	return {
		event_id: `question-${frame.interactionId}`,
		source_sequence: "0",
		input_attention_changed: { pending_count: frame.pendingCount }
	};
}
function cardKind(view) {
	if (view === void 0) return "KIND_UNSUPPORTED";
	switch (view.card) {
		case "terminal": return "KIND_TERMINAL";
		case "diff": return "KIND_DIFF";
		default: return "KIND_GENERIC";
	}
}
function viewTitle(view) {
	if (view === void 0 || !("title" in view)) return void 0;
	return typeof view.title === "string" && view.title !== "" ? view.title : void 0;
}
/**
* Minimize the path-bearing fields a tool view carries across the carrier:
* the `locations`/`diffs` path fields, plus every occurrence of those same raw
* paths inside the presenter title (presenters compose titles from the raw
* path, e.g. `Write <file_path>`). The workspace root stays a Host-side
* matching key; an outside path reduces to its final component, exactly like
* the artifact roster. Terminal command text is the model's literal record
* and is never rewritten.
*/
function minimizeToolViewPaths(view, cwd) {
	const record = view;
	const rawPaths = [];
	const minimizeEntries = (value) => {
		if (!Array.isArray(value)) return void 0;
		return value.map((entry) => {
			if (typeof entry !== "object" || entry === null) return entry;
			const record = entry;
			const path = record.path;
			if (typeof path !== "string" || path === "") return entry;
			rawPaths.push(path);
			const minimized = minimizePath(path, cwd).minimized;
			return minimized === path ? entry : {
				...record,
				path: minimized
			};
		});
	};
	const locations = minimizeEntries(record.locations);
	const diffs = minimizeEntries(record.diffs);
	let title = typeof record.title === "string" && record.title !== "" ? record.title : void 0;
	if (title !== void 0) for (const raw of [...new Set(rawPaths)].sort((a, b) => b.length - a.length)) {
		const minimized = minimizePath(raw, cwd).minimized;
		if (minimized === raw) continue;
		title = title.replaceAll(raw, minimized);
		const normalized = normalizeSlashes(raw);
		if (normalized !== raw) title = title.replaceAll(normalized, minimized);
	}
	return {
		...view,
		...locations === void 0 ? {} : { locations },
		...diffs === void 0 ? {} : { diffs },
		...title === void 0 || title === record.title ? {} : { title }
	};
}
function toolPresentation(callId, toolName, view, fallbackView, maxChars, cwd) {
	const minimizedView = view === void 0 ? void 0 : minimizeToolViewPaths(view.view, cwd);
	const minimizedFallback = fallbackView === void 0 ? void 0 : minimizeToolViewPaths(fallbackView.view, cwd);
	const effective = minimizedView ?? minimizedFallback;
	const bounded = effective === void 0 ? {
		text: "",
		truncated: false
	} : boundedJson(effective, maxChars);
	return {
		kind: cardKind(effective),
		call_id: callId,
		tool_name: toolName,
		summary: viewTitle(minimizedView) ?? viewTitle(minimizedFallback) ?? toolName,
		bounded_content: bounded.text,
		truncated: bounded.truncated
	};
}
function eventId(event) {
	return `source-event-${event.seq}`;
}
const SOURCE_FIELD_BOUND = 100;
/**
* Minimize a durable user/message source to bounded provenance. Identifiers
* (rpcId, promptCorrelation) never cross; plugin/form travel only for plugin
* (injected-context) sources.
*/
function messageSourceWire(source) {
	if (typeof source !== "object" || source === null) return void 0;
	const record = source;
	const kind = record.kind;
	if (typeof kind !== "string" || kind === "" || kind.length > SOURCE_FIELD_BOUND) return void 0;
	const wire = { kind };
	if (kind === "plugin") {
		const { plugin, form } = record;
		if (typeof plugin === "string" && plugin !== "" && plugin.length <= SOURCE_FIELD_BOUND) wire.plugin = plugin;
		if (typeof form === "string" && form !== "" && form.length <= SOURCE_FIELD_BOUND) wire.form = form;
	}
	return wire;
}
/** Durable turn/end reason kinds mapped onto the closed wire enum. */
const TURN_END_REASON_WIRE = {
	completed: "TURN_END_REASON_COMPLETED",
	aborted: "TURN_END_REASON_ABORTED",
	blocked: "TURN_END_REASON_BLOCKED",
	error: "TURN_END_REASON_ERROR",
	"max-tokens": "TURN_END_REASON_MAX_TOKENS",
	interrupted: "TURN_END_REASON_INTERRUPTED"
};
/** Map a merge-extensible turn/end reason; plugin-extended kinds stay absent. */
function turnEndReasonWire(reason) {
	if (typeof reason !== "object" || reason === null) return void 0;
	const kind = reason.kind;
	return typeof kind === "string" ? TURN_END_REASON_WIRE[kind] : void 0;
}
function currentSurfaceSequences(entries, truncated) {
	if (truncated) return new Set(entries.map((entry) => entry.event).filter((event) => event.type === "user/message" || event.type === "assistant/message" || event.type === "tool/result").map((event) => event.seq));
	return new Set(foldSurface(entries.map((entry) => entry.event)).nodes);
}
function fallbackTitle(entries) {
	for (const { event } of entries) {
		if (event.type !== "user/message" || event.data.source.kind !== "user") continue;
		const text = textOf(event.data.content);
		if (text !== "") return text.length <= 80 ? text : `${text.slice(0, 79)}…`;
	}
	return "";
}
function activeTurn(entries) {
	let open;
	for (const { event } of entries) if (event.type === "turn/start") open = event.data.turn;
	else if (event.type === "turn/end" && open === event.data.turn) open = void 0;
	return open;
}
/**
* Build one source-ordered transcript, including unfinalized partials, from an ApiProxy history cut.
* @param input - Current Session state, history entries, watermarks, and content bounds.
* @returns The minimized snapshot and its live-frame filtering state.
*/
function projectSnapshot(input) {
	const surface = currentSurfaceSequences(input.entries, input.historyTruncated);
	const timeline = [];
	const calls = /* @__PURE__ */ new Map();
	const completedCalls = /* @__PURE__ */ new Set();
	const finalizedSteps = /* @__PURE__ */ new Set();
	for (const entry of input.entries) {
		const event = entry.event;
		if (event.type === "tool/call") calls.set(event.data.callId, {
			name: event.data.name,
			entry
		});
		else if (event.type === "tool/result") completedCalls.add(event.data.message.source.callId);
		else if (event.type === "assistant/message") finalizedSteps.add(`${event.data.turn}:${event.data.step}`);
	}
	for (const entry of input.entries) {
		const event = entry.event;
		if (!surface.has(event.seq)) continue;
		if (event.type === "user/message") {
			const source = messageSourceWire(event.data.source);
			const text = textOf(event.data.content);
			const attachments = imageAttachmentsWire(event.data.content);
			timeline.push({
				event_id: eventId(event),
				source_sequence: String(event.seq),
				user_message: {
					text: source?.kind === "plugin" ? boundedText(text, input.maxToolContentChars) : text,
					...source === void 0 ? {} : { source },
					...attachments === void 0 ? {} : { attachments }
				}
			});
		} else if (event.type === "assistant/message") timeline.push({
			event_id: eventId(event),
			source_sequence: String(event.seq),
			assistant_message: {
				text: textOf(event.data.message.content),
				final: true,
				message_id: `assistant-${event.data.turn}-${event.data.step}`
			}
		});
		else {
			const result = event;
			const callId = result.data.message.source.callId;
			const call = calls.get(callId);
			timeline.push({
				event_id: `source-tool-${callId}`,
				source_sequence: String(result.seq),
				tool_presentation: toolPresentation(callId, call?.name ?? "tool", entry.view, call?.entry.view, input.maxToolContentChars, input.cwd)
			});
		}
	}
	const chunks = /* @__PURE__ */ new Map();
	for (const { event } of input.entries) {
		if (event.type !== "assistant/chunk" || event.data.chunk.type !== "text-delta") continue;
		const key = `${event.data.turn}:${event.data.step}`;
		if (finalizedSteps.has(key)) continue;
		const prior = chunks.get(key);
		chunks.set(key, {
			text: `${prior?.text ?? ""}${event.data.chunk.text}`,
			last: event
		});
	}
	for (const [key, partial] of chunks) timeline.push({
		event_id: `source-assistant-${key}`,
		source_sequence: String(partial.last.seq),
		assistant_message: {
			text: partial.text,
			final: false,
			message_id: `assistant-${key.replace(":", "-")}`
		}
	});
	for (const [callId, call] of calls) {
		if (completedCalls.has(callId)) continue;
		timeline.push({
			event_id: `source-tool-${callId}`,
			source_sequence: String(call.entry.event.seq),
			tool_presentation: toolPresentation(callId, call.name, call.entry.view, void 0, input.maxToolContentChars, input.cwd)
		});
	}
	timeline.sort((left, right) => Number(left.source_sequence) - Number(right.source_sequence));
	const usage = sessionUsageWire(input.usage);
	const subagent = subagentViewWire(input.subagent);
	const model = modelSelectionWire(input.model);
	const policyWire = policyChangedWire(input.policy ?? { rules: [] }, input.budgetExhausted === true);
	return {
		session: {
			session_id: input.sessionId,
			title: input.title ?? fallbackTitle(input.entries),
			running: input.running,
			timeline,
			history_truncated: input.historyTruncated,
			activity_revision: String(activeTurn(input.entries) ?? 0),
			approvals: (input.approvals ?? []).map((interaction) => projectApprovalInteraction(interaction, input.maxToolContentChars)),
			pending_input_count: input.pendingInputCount ?? 0,
			...usage === void 0 ? {} : { usage },
			...subagent === void 0 ? {} : { subagent },
			...input.agentPreset === void 0 ? {} : { agent_preset: input.agentPreset },
			...model === void 0 ? {} : { model },
			approval_rules: policyWire.rules,
			...policyWire.budget === void 0 ? {} : { budget: policyWire.budget }
		},
		sourceWatermark: input.sourceWatermark,
		projectionWatermark: input.projectionWatermark,
		toolNames: new Map([...calls].map(([callId, value]) => [callId, value.name]))
	};
}
/**
* Map one allowlisted live source frame to a v1alpha projected event.
* @param input - Source event, optional Host view, tool-name state, and content bound.
* @returns A projected event, snapshot invalidation request, or ignore decision.
*/
function projectLiveFrame(input) {
	const { event } = input;
	if ("surfaceOp" in event && typeof event.surfaceOp === "object") return {
		kind: "snapshot-required",
		detail: "session surface was replaced"
	};
	const common = {
		event_id: eventId(event),
		source_sequence: String(event.seq)
	};
	if (event.type === "agent-preset/selected") {
		const raw = event.data.agentPreset;
		const agentPreset = typeof raw === "string" && raw !== "" && raw.length <= 100 ? raw : void 0;
		if (agentPreset === void 0) return { kind: "ignore" };
		return {
			kind: "event",
			payload: {
				...common,
				agent_preset_changed: { agent_preset: agentPreset }
			}
		};
	}
	switch (event.type) {
		case "request/header": {
			if (event.data.reason !== "change") return { kind: "ignore" };
			const config = event.data.header.config;
			const provider = typeof config.provider === "string" && config.provider !== "" && config.provider.length <= 100 ? config.provider : void 0;
			const model = typeof config.model === "string" && config.model !== "" && config.model.length <= 200 ? config.model : void 0;
			if (provider === void 0 || model === void 0) return { kind: "ignore" };
			const effort = typeof config.reasoningEffort === "string" && config.reasoningEffort !== "" && config.reasoningEffort.length <= 100 ? config.reasoningEffort : void 0;
			return {
				kind: "event",
				payload: {
					...common,
					model_changed: {
						provider,
						model,
						...effort === void 0 ? {} : { reasoning_effort: effort }
					}
				}
			};
		}
		case "turn/start": return {
			kind: "event",
			payload: {
				...common,
				session_status_changed: {
					running: true,
					activity_revision: String(event.data.turn)
				}
			}
		};
		case "turn/end": {
			const reason = turnEndReasonWire(event.data.reason);
			return {
				kind: "event",
				payload: {
					...common,
					session_status_changed: {
						running: false,
						activity_revision: "0",
						...reason === void 0 ? {} : { turn_end_reason: reason }
					}
				}
			};
		}
		case "user/message": {
			const source = messageSourceWire(event.data.source);
			const text = textOf(event.data.content);
			const attachments = imageAttachmentsWire(event.data.content);
			return {
				kind: "event",
				payload: {
					...common,
					user_message_added: {
						message_id: event.data.id,
						text: source?.kind === "plugin" ? boundedText(text, input.maxToolContentChars) : text,
						...source === void 0 ? {} : { source },
						...attachments === void 0 ? {} : { attachments }
					}
				}
			};
		}
		case "assistant/chunk":
			if (event.data.chunk.type !== "text-delta" || event.data.chunk.text === "") return { kind: "ignore" };
			return {
				kind: "event",
				payload: {
					...common,
					assistant_delta: {
						message_id: `assistant-${event.data.turn}-${event.data.step}`,
						text_delta: event.data.chunk.text
					}
				}
			};
		case "assistant/message": return {
			kind: "event",
			payload: {
				...common,
				assistant_completed: {
					message_id: `assistant-${event.data.turn}-${event.data.step}`,
					text: textOf(event.data.message.content)
				}
			}
		};
		case "tool/call":
			input.toolNames.set(event.data.callId, event.data.name);
			return {
				kind: "event",
				payload: {
					...common,
					tool_presentation_changed: { presentation: toolPresentation(event.data.callId, event.data.name, input.view, void 0, input.maxToolContentChars, input.cwd) }
				}
			};
		case "tool/result": {
			const callId = event.data.message.source.callId;
			return {
				kind: "event",
				payload: {
					...common,
					tool_presentation_changed: { presentation: toolPresentation(callId, input.toolNames.get(callId) ?? "tool", input.view, void 0, input.maxToolContentChars, input.cwd) }
				}
			};
		}
		default: return { kind: "ignore" };
	}
}
//#endregion
//#region src/host/secure-channel.ts
/**
* Server side of the Noise-authenticated secure framing (`SecureConnect`).
*
* One implementation serves every v1alpha secure carrier: the Remote
* projection channel and the supervisor management channel (ADR-007) run the
* exact same hello → IK → authorize → AEAD state machine, differing only in
* the security authority they present, the capability mask that admits a
* device, and the plaintext protocol spoken inside the envelope. Keeping the
* framing single-sourced is a security property — the channels cannot drift.
*/
/** Secure hello must speak this framing version. */
const SECURE_PROTOCOL_VERSION = 1;
function envelope(payload) {
	return {
		frame_id: randomUUID(),
		...payload
	};
}
var SecureCallImpl = class extends EventEmitter {
	call;
	transport;
	deserializeClient;
	serializeServer;
	authorized;
	#closed = false;
	#authorizationFenced = false;
	#fenceTimer;
	constructor(call, transport, deserializeClient, serializeServer, authorized) {
		super();
		this.call = call;
		this.transport = transport;
		this.deserializeClient = deserializeClient;
		this.serializeServer = serializeServer;
		this.authorized = authorized;
		call.once("cancelled", () => {
			this.#close("cancelled");
		});
		call.once("close", () => {
			this.#close("close");
		});
		call.once("error", (error) => {
			this.#close("error", error);
		});
		call.on("end", () => {
			this.#close("end");
		});
	}
	receive(ciphertext) {
		if (this.#closed) return;
		if (ciphertext.length > 65535) {
			this.destroy(/* @__PURE__ */ new Error("secure frame exceeds the Noise message bound"));
			return;
		}
		if (!this.authorized()) {
			this.fenceAuthorizationChange(true);
			return;
		}
		try {
			const plaintext = this.transport.decrypt(ciphertext);
			this.emit("data", this.deserializeClient(plaintext));
		} catch {
			this.destroy(/* @__PURE__ */ new Error("secure frame authentication failed"));
		}
	}
	write(message) {
		if (this.#closed) return false;
		if (!this.authorized()) {
			this.fenceAuthorizationChange(true);
			return false;
		}
		try {
			const plaintext = this.serializeServer(message);
			if (plaintext.length > 65519) {
				this.destroy(/* @__PURE__ */ new Error("remote frame exceeds the Noise plaintext bound"));
				return false;
			}
			const ciphertext = this.transport.encrypt(plaintext);
			return this.call.write(envelope({ ciphertext }));
		} catch {
			this.destroy(/* @__PURE__ */ new Error("secure frame encryption failed"));
			return false;
		}
	}
	fenceAuthorizationChange(closeAfterWrite = false) {
		if (!this.#closed && !this.authorized()) {
			if (!this.#authorizationFenced || closeAfterWrite) this.call.write(envelope({ error: {
				code: "SECURE_ERROR_CODE_UNAUTHORIZED_DEVICE",
				detail: "device authorization changed"
			} }));
			this.#authorizationFenced = true;
			if (closeAfterWrite) this.#terminateAuthorizationFence(true);
			else if (this.#fenceTimer === void 0) {
				this.#fenceTimer = setTimeout(() => {
					this.#terminateAuthorizationFence(false);
				}, 15e3);
				this.#fenceTimer.unref();
			}
		}
	}
	end() {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearFenceTimer();
		this.call.end();
		this.emit("end");
	}
	destroy(error) {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearFenceTimer();
		if (error === void 0) {
			this.call.end();
			this.emit("close");
		} else {
			this.call.emit("error", error);
			this.emit("error", error);
		}
	}
	#close(event, error) {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearFenceTimer();
		if (event === "error") this.emit("error", error ?? /* @__PURE__ */ new Error("secure carrier failed"));
		else this.emit(event);
	}
	#terminateAuthorizationFence(deferEnd) {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearFenceTimer();
		const end = () => {
			this.call.end();
		};
		if (deferEnd) setImmediate(end);
		else end();
		this.emit("error", /* @__PURE__ */ new Error("device authorization changed"));
	}
	#clearFenceTimer() {
		if (this.#fenceTimer === void 0) return;
		clearTimeout(this.#fenceTimer);
		this.#fenceTimer = void 0;
	}
};
/**
* All live secure calls of one gRPC service: accepts streams, walks each
* through the handshake state machine, and owns their teardown.
*/
var SecureChannelServer = class {
	options;
	#connections = /* @__PURE__ */ new Set();
	#disposed = false;
	constructor(options) {
		this.options = options;
	}
	/** Serve one incoming `SecureConnect` stream until either side ends it. */
	accept(call) {
		if (this.#disposed) {
			call.destroy(/* @__PURE__ */ new Error("secure channel disposed"));
			return;
		}
		const state = {
			call,
			incoming: Promise.resolve(),
			phase: "awaiting-hello"
		};
		this.#connections.add(state);
		const dispose = () => {
			state.phase = "closed";
			this.#connections.delete(state);
		};
		call.once("cancelled", dispose);
		call.once("close", dispose);
		call.once("error", dispose);
		call.on("end", () => {
			dispose();
			call.end();
		});
		call.on("data", (message) => {
			state.incoming = state.incoming.then(() => {
				this.#onFrame(state, message);
			}).catch(() => {
				this.#writeError(state, "SECURE_ERROR_CODE_CRYPTOGRAPHIC_FAILURE", "secure connection failed closed");
				state.phase = "closed";
				state.call.end();
			});
		});
	}
	/** Re-check every authenticated call against its authority epoch. */
	fenceAll() {
		for (const state of this.#connections) state.remoteCall?.fenceAuthorizationChange();
	}
	/** End every live call and await their incoming chains. */
	async stop() {
		if (this.#disposed) return;
		this.#disposed = true;
		const states = [...this.#connections];
		for (const state of states) {
			state.phase = "closed";
			state.call.end();
		}
		await Promise.allSettled(states.map((state) => state.incoming));
		this.#connections.clear();
	}
	#onFrame(state, message) {
		if (state.phase === "closed") return;
		if (message.hello !== void 0) {
			if (state.phase !== "awaiting-hello") {
				this.#writeError(state, "SECURE_ERROR_CODE_INVALID_REQUEST", "secure hello already received");
				return;
			}
			if (message.hello.protocol_version !== SECURE_PROTOCOL_VERSION) {
				this.#writeError(state, "SECURE_ERROR_CODE_INCOMPATIBLE_VERSION", `expected protocol ${SECURE_PROTOCOL_VERSION}`);
				state.call.end();
				return;
			}
			const connectionId = message.hello.connection_id;
			const presentedHostKey = message.hello.host_public_key;
			if (typeof connectionId !== "string" || !Buffer.isBuffer(presentedHostKey)) {
				this.#writeError(state, "SECURE_ERROR_CODE_INVALID_REQUEST", "secure hello fields required");
				return;
			}
			state.security = this.options.security();
			const hostPublicKey = state.security.hostPublicKey();
			if (presentedHostKey.length !== hostPublicKey.length || !timingSafeEqual(presentedHostKey, hostPublicKey)) {
				this.#writeError(state, "SECURE_ERROR_CODE_HOST_IDENTITY_MISMATCH", "pinned Host identity does not match");
				state.call.end();
				return;
			}
			state.handshake = state.security.connectionResponder(connectionPrologue(hostPublicKey, connectionId));
			state.phase = "handshaking";
			return;
		}
		if (message.handshake_message !== void 0) {
			if (state.phase !== "handshaking" || state.handshake === void 0 || state.security === void 0) {
				this.#writeError(state, "SECURE_ERROR_CODE_INVALID_REQUEST", "secure hello required");
				return;
			}
			if (message.handshake_message.length > 65535) throw new Error("handshake message exceeds the Noise bound");
			const security = state.security;
			if (state.handshake.read(Buffer.from(message.handshake_message)).length !== 0) throw new Error("handshake payload is not allowed");
			const response = state.handshake.write(Buffer.alloc(0));
			state.call.write(envelope({ handshake_message: response }));
			if (!state.handshake.finished()) throw new Error("IK handshake did not finish");
			const peerPublicKey = state.handshake.peerPublicKey();
			const authorization = security.authorizeCapabilities(peerPublicKey, this.options.admissionCapabilities);
			if (authorization.decision !== "allowed") {
				this.#writeError(state, "SECURE_ERROR_CODE_UNAUTHORIZED_DEVICE", "authenticated device is not authorized");
				state.phase = "closed";
				state.call.end();
				return;
			}
			const deviceId = Buffer.from(authorization.deviceId);
			const authorityEpoch = authorization.authorityEpoch;
			const transport = state.handshake.finishTransport();
			const authorized = () => {
				const current = security.authorizeCapabilities(peerPublicKey, this.options.admissionCapabilities);
				return current.decision === "allowed" && current.authorityEpoch === authorityEpoch && current.deviceId.length === deviceId.length && timingSafeEqual(current.deviceId, deviceId);
			};
			delete state.handshake;
			state.phase = "authenticated";
			const secureCall = new SecureCallImpl(state.call, transport, this.options.deserializeClient, this.options.serializeServer, authorized);
			state.remoteCall = secureCall;
			this.options.onAuthenticated({
				call: secureCall,
				devicePublicKey: peerPublicKey,
				deviceId,
				grantedCapabilities: authorization.grantedCapabilities,
				authorityEpoch
			});
			return;
		}
		if (message.ciphertext !== void 0) {
			if (state.phase !== "authenticated" || state.remoteCall === void 0) {
				this.#writeError(state, "SECURE_ERROR_CODE_INVALID_REQUEST", "Noise IK handshake required");
				return;
			}
			state.remoteCall.receive(Buffer.from(message.ciphertext));
			return;
		}
		this.#writeError(state, "SECURE_ERROR_CODE_INVALID_REQUEST", "unknown secure frame");
	}
	#writeError(state, code, detail) {
		if (state.phase === "closed") return;
		state.call.write(envelope({ error: {
			code,
			detail
		} }));
	}
};
//#endregion
//#region src/host/transport.ts
/** Noise-authenticated gRPC carrier for the read-only Remote projection. */
const PROTOCOL_VERSION = 1;
const LOOPBACK_HOST = "127.0.0.1";
const MAX_SECURE_ENVELOPE_BYTES = 7e4;
var AsyncFrameQueue = class {
	#frames = [];
	#waiters = [];
	#closed = false;
	push(frame) {
		if (this.#closed) return;
		const waiter = this.#waiters.shift();
		if (waiter !== void 0) waiter({
			done: false,
			value: frame
		});
		else this.#frames.push(frame);
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({
			done: true,
			value: void 0
		});
	}
	async next() {
		const frame = this.#frames.shift();
		if (frame !== void 0) return {
			done: false,
			value: frame
		};
		if (this.#closed) return {
			done: true,
			value: void 0
		};
		return await new Promise((resolve) => this.#waiters.push(resolve));
	}
};
function resolveProtocolDescriptor() {
	for (const spec of [new URL("../protocol/v1alpha/dsh_remote_v1alpha.proto", import.meta.url), new URL("../../protocol/v1alpha/dsh_remote_v1alpha.proto", import.meta.url)]) {
		const pathname = fileURLToPath(spec);
		if (existsSync(pathname)) return pathname;
	}
	throw new Error("DSH Remote protocol descriptor is missing from the installed package");
}
function remoteService() {
	const protoPath = resolveProtocolDescriptor();
	const definition = protoLoader.loadSync(protoPath, {
		defaults: true,
		enums: String,
		keepCase: true,
		longs: String,
		oneofs: true
	});
	return grpc.loadPackageDefinition(definition).dsh.remote.v1alpha.RemoteTransport;
}
function serverFrame(payload) {
	return {
		frame_id: randomUUID(),
		...payload
	};
}
const uint64Pattern = /^(0|[1-9]\d*)$/;
const controlTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const remoteIdentifierPattern = /^[\x21-\x7e]{1,128}$/;
const UINT64_MAX = 18446744073709551615n;
function validSessionId(value) {
	if (typeof value !== "string") return false;
	const length = Array.from(value).length;
	return length >= 1 && length <= 256;
}
function controlFailure(reason) {
	return {
		"held-by-other": {
			code: "ERROR_CODE_CONTROL_HELD_BY_OTHER",
			detail: "Session control is held by another device"
		},
		unheld: {
			code: "ERROR_CODE_CONTROL_UNHELD",
			detail: "Session control is not currently held"
		},
		expired: {
			code: "ERROR_CODE_CONTROL_EXPIRED",
			detail: "Session control lease expired"
		},
		"stale-fence": {
			code: "ERROR_CODE_CONTROL_STALE_FENCE",
			detail: "Session control fence is stale"
		}
	}[reason];
}
function commandError(terminal) {
	if (terminal.outcome === "unknown") return {
		code: "ERROR_CODE_COMMAND_OUTCOME_UNKNOWN",
		detail: "The Host cannot currently prove the command outcome; retry with the same command_id"
	};
	return {
		"command-id-reused": {
			code: "ERROR_CODE_COMMAND_ID_REUSED",
			detail: "command_id was already bound to different semantics"
		},
		"authorization-denied": {
			code: "ERROR_CODE_AUTHORIZATION_DENIED",
			detail: "The authenticated device is not authorized for this command"
		},
		"control-held-by-other": controlFailure("held-by-other"),
		"control-unheld": controlFailure("unheld"),
		"control-expired": controlFailure("expired"),
		"control-stale-fence": controlFailure("stale-fence"),
		"session-not-found": {
			code: "ERROR_CODE_SESSION_NOT_FOUND",
			detail: "The requested Session is unavailable"
		},
		"invalid-control-proof": {
			code: "ERROR_CODE_INVALID_REQUEST",
			detail: "The command control proof is invalid"
		},
		"approval-revision-stale": {
			code: "ERROR_CODE_APPROVAL_REVISION_STALE",
			detail: "The approval revision is stale"
		},
		"approval-not-pending": {
			code: "ERROR_CODE_APPROVAL_NOT_PENDING",
			detail: "The approval is no longer pending"
		},
		"approval-outcome-not-allowed": {
			code: "ERROR_CODE_APPROVAL_OUTCOME_NOT_ALLOWED",
			detail: "The requested approval outcome is not allowed"
		},
		"approval-already-settled": {
			code: "ERROR_CODE_APPROVAL_REVISION_STALE",
			detail: "The approval already settled with another outcome"
		},
		"agent-preset-not-found": {
			code: "ERROR_CODE_AGENT_PRESET_NOT_FOUND",
			detail: "The named agent preset is not in the deployment roster"
		},
		"agent-preset-locked": {
			code: "ERROR_CODE_AGENT_PRESET_LOCKED",
			detail: "The Session already started; its agent preset is fixed"
		},
		"agent-preset-invalid": {
			code: "ERROR_CODE_AGENT_PRESET_INVALID",
			detail: "The named agent preset cannot compose a Session"
		},
		"model-unavailable": {
			code: "ERROR_CODE_MODEL_UNAVAILABLE",
			detail: "The provider, model, or reasoning effort cannot serve this Session"
		},
		"fork-unavailable": {
			code: "ERROR_CODE_FORK_UNAVAILABLE",
			detail: "The Session has no completed turn at the requested fork anchor"
		},
		"session-conflict": {
			code: "ERROR_CODE_SESSION_CONFLICT",
			detail: "The preallocated session_id is bound to different semantics"
		},
		"fork-conflict": {
			code: "ERROR_CODE_SESSION_CONFLICT",
			detail: "The preallocated child_session_id is bound to different lineage"
		},
		"attachment-error": {
			code: "ERROR_CODE_ATTACHMENT_UNAVAILABLE",
			detail: "An attached image is unknown, not yet committed, or not an accepted image"
		},
		"budget-exhausted": {
			code: "ERROR_CODE_BUDGET_EXHAUSTED",
			detail: "The session token budget is exhausted; raise the ceiling to continue"
		},
		"workspace-not-found": {
			code: "ERROR_CODE_WORKSPACE_NOT_FOUND",
			detail: "The named workspace is not in the Host registry"
		},
		"workspace-invalid-name": {
			code: "ERROR_CODE_WORKSPACE_INVALID_NAME",
			detail: "new_workspace_name must be a single folder name under an existing workspace"
		},
		"workspace-create-failed": {
			code: "ERROR_CODE_WORKSPACE_CREATE_FAILED",
			detail: "The Host could not create or register the child workspace folder"
		},
		"workspace-invalid-path": {
			code: "ERROR_CODE_WORKSPACE_CREATE_FAILED",
			detail: "The Host could not create or register the child workspace folder"
		},
		"rule-not-found": {
			code: "ERROR_CODE_INVALID_REQUEST",
			detail: "The named approval rule is not active"
		},
		"approval-class-underivable": {
			code: "ERROR_CODE_APPROVAL_OUTCOME_NOT_ALLOWED",
			detail: "No honest rule class is derivable for this approval"
		},
		"approval-rule-limit": {
			code: "ERROR_CODE_APPROVAL_OUTCOME_NOT_ALLOWED",
			detail: "The session already holds the maximum number of active approval rules"
		},
		"approval-policy-unavailable": {
			code: "ERROR_CODE_COMMAND_UNAVAILABLE",
			detail: "The approval policy owner is not composed in this Host"
		},
		"budget-meter-unavailable": {
			code: "ERROR_CODE_COMMAND_UNAVAILABLE",
			detail: "No usage meter is composed; a session budget cannot bind"
		},
		"invalid-budget": {
			code: "ERROR_CODE_INVALID_REQUEST",
			detail: "The session budget must be a positive integer ceiling"
		}
	}[terminal.errorCode] ?? {
		code: "ERROR_CODE_COMMAND_UNAVAILABLE",
		detail: "The command owner rejected this request before execution"
	};
}
/** Map an assembler failure onto the proto transfer vocabulary (S-blob). */
function blobTransferErrorWire(error) {
	return {
		code: {
			"invalid-declaration": "BLOB_TRANSFER_ERROR_INVALID_DECLARATION",
			"declaration-conflict": "BLOB_TRANSFER_ERROR_DECLARATION_CONFLICT",
			"unknown-transfer": "BLOB_TRANSFER_ERROR_UNKNOWN_TRANSFER",
			"too-many-transfers": "BLOB_TRANSFER_ERROR_TOO_MANY_TRANSFERS",
			"chunk-too-large": "BLOB_TRANSFER_ERROR_CHUNK_TOO_LARGE",
			"offset-mismatch": "BLOB_TRANSFER_ERROR_OFFSET_MISMATCH",
			"size-mismatch": "BLOB_TRANSFER_ERROR_SIZE_MISMATCH",
			"digest-mismatch": "BLOB_TRANSFER_ERROR_DIGEST_MISMATCH",
			"commit-rejected": "BLOB_TRANSFER_ERROR_COMMIT_REJECTED"
		}[error.code],
		detail: error.message,
		...error.resumeOffset === void 0 ? {} : { resume_offset: String(error.resumeOffset) }
	};
}
/** Map a fetch-server failure onto the proto fetch vocabulary (S-blob). */
function blobFetchErrorWire(error) {
	return {
		code: {
			"invalid-request": "BLOB_FETCH_ERROR_INVALID_REQUEST",
			"fetch-conflict": "BLOB_FETCH_ERROR_CONFLICT",
			"too-many-fetches": "BLOB_FETCH_ERROR_TOO_MANY_FETCHES",
			"unknown-fetch": "BLOB_FETCH_ERROR_UNKNOWN_FETCH",
			"unauthorized": "BLOB_FETCH_ERROR_UNAUTHORIZED",
			"content-too-large": "BLOB_FETCH_ERROR_CONTENT_TOO_LARGE",
			"offset-out-of-range": "BLOB_FETCH_ERROR_OFFSET_OUT_OF_RANGE",
			"source-changed": "BLOB_FETCH_ERROR_SOURCE_CHANGED"
		}[error.code],
		detail: error.message
	};
}
function stopError(terminal) {
	if (terminal.outcome === "unknown") return {
		code: "ERROR_CODE_STOP_SETTLEMENT_UNKNOWN",
		detail: "The Host cannot prove Stop settlement; reconcile with the same command_id"
	};
	return {
		"command-id-reused": {
			code: "ERROR_CODE_COMMAND_ID_REUSED",
			detail: "command_id was already bound to different semantics"
		},
		"authorization-denied": {
			code: "ERROR_CODE_AUTHORIZATION_DENIED",
			detail: "The authenticated device is not authorized to Stop"
		},
		"control-held-by-other": controlFailure("held-by-other"),
		"control-unheld": controlFailure("unheld"),
		"control-expired": controlFailure("expired"),
		"control-stale-fence": controlFailure("stale-fence"),
		"session-not-found": {
			code: "ERROR_CODE_SESSION_NOT_FOUND",
			detail: "The requested Session is unavailable"
		},
		"activity-revision-stale": {
			code: "ERROR_CODE_ACTIVITY_REVISION_STALE",
			detail: "The requested activity is no longer the active turn"
		},
		"invalid-control-proof": {
			code: "ERROR_CODE_INVALID_REQUEST",
			detail: "The Stop control proof is invalid"
		}
	}[terminal.errorCode] ?? {
		code: "ERROR_CODE_COMMAND_UNAVAILABLE",
		detail: "The Stop owner rejected this request before execution"
	};
}
/** One private carrier instance; lifecycle is owned by the plugin effect. */
var RemoteGrpcCarrier = class {
	source;
	options;
	#server = new grpc.Server({ "grpc.max_receive_message_length": MAX_SECURE_ENVELOPE_BYTES });
	#connections = /* @__PURE__ */ new Set();
	#secureChannel;
	#pairingConnections = /* @__PURE__ */ new Set();
	#tasks = /* @__PURE__ */ new Set();
	#cursors;
	#disposed = false;
	constructor(source, options) {
		this.source = source;
		this.options = options;
		this.#cursors = new RetainedProjectionCursorStore({
			maxEvents: options.maxRetainedEvents,
			maxJsonBytes: options.maxRetainedJsonBytes,
			detachedTtlMs: options.resumeRetentionTtlMs,
			maxGenerations: options.maxRetainedGenerations
		});
		const descriptor = remoteService();
		const connectMethod = descriptor.service.Connect;
		const pairMethod = descriptor.service.Pair;
		this.#secureChannel = new SecureChannelServer({
			security: () => this.options.security,
			admissionCapabilities: "3",
			deserializeClient: (bytes) => connectMethod.requestDeserialize(bytes),
			serializeServer: (frame) => Buffer.from(connectMethod.responseSerialize(frame)),
			onAuthenticated: (session) => {
				this.#connect(session.call, session.devicePublicKey, session.deviceId, session.grantedCapabilities, session.authorityEpoch);
			}
		});
		this.#server.addService(descriptor.service, {
			Connect: (call) => {
				const error = /* @__PURE__ */ new Error("paired device authentication required");
				error.code = grpc.status.UNAUTHENTICATED;
				error.details = error.message;
				error.metadata = new grpc.Metadata();
				call.emit("error", error);
			},
			SecureConnect: (call) => {
				if (this.#disposed) {
					call.destroy(/* @__PURE__ */ new Error("remote carrier disposed"));
					return;
				}
				this.#secureChannel.accept(call);
			},
			Pair: (call) => {
				this.#pair(call, (frame) => Buffer.from(pairMethod.responseSerialize(frame)));
			}
		});
	}
	/**
	* Bind the insecure gRPC listener beneath the authenticated Noise carrier.
	* @returns The actual bound port.
	*/
	async start() {
		if (this.#disposed) throw new Error("remote carrier is disposed");
		return await new Promise((resolve, reject) => {
			this.#server.bindAsync(`${this.options.host ?? LOOPBACK_HOST}:${this.options.port}`, grpc.ServerCredentials.createInsecure(), (error, port) => {
				if (error === null) resolve(port);
				else reject(error);
			});
		});
	}
	/** Terminate authenticated streams whose durable authority no longer matches their connection epoch. */
	fenceAuthorizationChanges() {
		this.#secureChannel.fenceAll();
		this.#cursors.fenceAuthorization((domain) => {
			const current = this.options.security.authorizeCapabilities(Buffer.from(domain.devicePublicKey, "hex"), "3");
			return current.decision === "allowed" && current.authorityEpoch === domain.authorityEpoch;
		});
	}
	/** End active streams, await carrier tasks, and release the listener. */
	async stop() {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#cursors.stop();
		for (const state of [...this.#connections]) {
			state.setupAbort?.abort();
			state.call.end();
		}
		const secureStopped = this.#secureChannel.stop();
		for (const state of [...this.#pairingConnections]) {
			if (state.phase === "awaiting-confirmation" && state.invitationId !== void 0) this.options.security.rejectPairing(state.invitationId);
			state.phase = "closed";
			state.call.end();
		}
		await Promise.allSettled([
			...this.#tasks,
			...[...this.#connections].map((state) => state.incoming),
			secureStopped,
			...[...this.#pairingConnections].map((state) => state.incoming)
		]);
		await new Promise((resolve) => {
			this.#server.tryShutdown(() => {
				resolve();
			});
		});
		this.#connections.clear();
		this.#pairingConnections.clear();
	}
	#track(task) {
		this.#tasks.add(task);
		task.finally(() => {
			this.#tasks.delete(task);
		});
		return task;
	}
	#pair(call, serializeServer) {
		if (this.#disposed) {
			call.destroy(/* @__PURE__ */ new Error("remote carrier disposed"));
			return;
		}
		const state = {
			call,
			incoming: Promise.resolve(),
			phase: "awaiting-hello"
		};
		this.#pairingConnections.add(state);
		const dispose = () => {
			if (state.phase === "awaiting-confirmation" && state.invitationId !== void 0) this.options.security.rejectPairing(state.invitationId);
			state.phase = "closed";
			this.#pairingConnections.delete(state);
		};
		call.once("cancelled", dispose);
		call.once("close", dispose);
		call.once("error", dispose);
		call.on("end", () => {
			dispose();
			call.end();
		});
		call.on("data", (message) => {
			state.incoming = state.incoming.then(() => {
				this.#onPairingFrame(state, message, serializeServer);
			}).catch(() => {
				this.#writePairingError(state, "SECURE_ERROR_CODE_CRYPTOGRAPHIC_FAILURE", "pairing failed closed");
				state.phase = "closed";
				state.call.end();
			});
		});
	}
	#onPairingFrame(state, message, serializeServer) {
		if (state.phase === "closed") return;
		if (message.hello !== void 0) {
			if (state.phase !== "awaiting-hello") {
				this.#writePairingError(state, "SECURE_ERROR_CODE_INVALID_REQUEST", "pairing hello already received");
				return;
			}
			const { protocol_version: version, invitation_id: invitationId, host_public_key: hostKey } = message.hello;
			const deviceName = message.hello.device_name?.trim();
			if (version !== PROTOCOL_VERSION) {
				this.#writePairingError(state, "SECURE_ERROR_CODE_INCOMPATIBLE_VERSION", `expected protocol ${PROTOCOL_VERSION}`);
				state.call.end();
				return;
			}
			if (!Buffer.isBuffer(invitationId) || !Buffer.isBuffer(hostKey) || deviceName === void 0) {
				this.#writePairingError(state, "SECURE_ERROR_CODE_INVALID_REQUEST", "pairing hello fields required");
				return;
			}
			state.handshake = this.options.security.pairingResponder(Buffer.from(invitationId), Buffer.from(hostKey), Date.now());
			state.invitationId = Buffer.from(invitationId);
			state.deviceName = deviceName;
			state.phase = "handshaking";
			return;
		}
		if (message.handshake_message !== void 0) {
			if (state.phase !== "handshaking" || state.handshake === void 0 || state.invitationId === void 0 || state.deviceName === void 0) {
				this.#writePairingError(state, "SECURE_ERROR_CODE_INVALID_REQUEST", "pairing hello required");
				return;
			}
			if (message.handshake_message.length > 65535) throw new Error("pairing handshake message exceeds the Noise bound");
			if (state.handshake.read(Buffer.from(message.handshake_message)).length !== 0) throw new Error("pairing handshake payload is not allowed");
			if (!state.handshake.finished()) {
				const response = state.handshake.write(Buffer.alloc(0));
				state.call.write(serverFrame({ handshake_message: response }));
				return;
			}
			const verificationCode = state.handshake.verificationCode();
			const devicePublicKey = state.handshake.peerPublicKey();
			state.transport = state.handshake.finishTransport();
			delete state.handshake;
			state.phase = "awaiting-confirmation";
			const decision = this.options.security.stagePairing(state.invitationId, devicePublicKey, state.deviceName, verificationCode, Date.now());
			this.#writePairingStatus(state, serializeServer, "STATE_AWAITING_HOST_CONFIRMATION", verificationCode);
			this.#track(decision.then((result) => {
				if (state.phase !== "awaiting-confirmation") return;
				this.#writePairingStatus(state, serializeServer, result === "confirmed" ? "STATE_CONFIRMED" : "STATE_REJECTED", verificationCode);
				state.phase = "closed";
				state.call.end();
			}));
			return;
		}
		this.#writePairingError(state, "SECURE_ERROR_CODE_INVALID_REQUEST", "unknown pairing frame");
	}
	#writePairingStatus(state, serializeServer, pairingState, verificationCode) {
		const transport = state.transport;
		if (transport === void 0) throw new Error("pairing transport is unavailable");
		const plaintext = serializeServer(serverFrame({ status: {
			state: pairingState,
			verification_code: verificationCode
		} }));
		if (plaintext.length > 65519) throw new Error("pairing status exceeds Noise bound");
		state.call.write(serverFrame({ ciphertext: transport.encrypt(plaintext) }));
	}
	#writePairingError(state, code, detail) {
		if (state.phase === "closed") return;
		state.call.write(serverFrame({ error: {
			code,
			detail
		} }));
	}
	#connect(call, devicePublicKey, deviceId, grantedCapabilities, authorityEpoch) {
		if (this.#disposed) {
			call.destroy(/* @__PURE__ */ new Error("remote carrier disposed"));
			return;
		}
		const stateRef = { current: void 0 };
		const currentState = () => {
			if (stateRef.current === void 0) throw new Error("Remote connection delivery is not initialized");
			return stateRef.current;
		};
		const state = {
			connectionId: randomUUID(),
			call,
			deviceId: Buffer.from(deviceId),
			grantedCapabilities,
			domain: {
				devicePublicKey: devicePublicKey.toString("hex"),
				authorityEpoch
			},
			delivery: {
				active: () => !currentState().closed,
				write: (frame) => currentState().call.write(serverFrame(frame)),
				backpressure: () => {
					const error = /* @__PURE__ */ new Error("Remote client exceeded the delivery backpressure bound");
					error.code = grpc.status.RESOURCE_EXHAUSTED;
					error.details = error.message;
					error.metadata = new grpc.Metadata();
					currentState().call.destroy(error);
				}
			},
			helloComplete: false,
			subscribed: false,
			closed: false,
			incoming: Promise.resolve()
		};
		stateRef.current = state;
		this.#connections.add(state);
		const dispose = () => {
			if (state.closed) return;
			state.closed = true;
			state.setupAbort?.abort();
			if (state.generation !== void 0) state.generation.detach(state.delivery);
			this.#connections.delete(state);
		};
		call.once("cancelled", dispose);
		call.once("close", dispose);
		call.once("error", dispose);
		call.on("end", () => {
			dispose();
			call.end();
		});
		call.on("data", (message) => {
			state.incoming = state.incoming.then(() => this.#onClientFrame(state, message)).catch((cause) => {
				this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", cause instanceof Error ? cause.message : String(cause));
			});
		});
	}
	async #onClientFrame(state, message) {
		if (message.hello !== void 0) {
			if (message.hello.protocol_version !== PROTOCOL_VERSION) {
				this.#writeError(state, "ERROR_CODE_INCOMPATIBLE_VERSION", `expected protocol ${PROTOCOL_VERSION}`);
				state.call.end();
				return;
			}
			const [sessions, presets, catalog, artifacts, workspaces] = await Promise.all([
				this.source.list(),
				this.source.presets(),
				this.source.modelCatalog(),
				this.options.artifacts === void 0 ? Promise.resolve([]) : this.options.artifacts.roster(),
				this.source.workspaces()
			]);
			state.helloComplete = true;
			state.call.write(serverFrame({ hello: {
				protocol_version: PROTOCOL_VERSION,
				connection_id: state.connectionId,
				host_instance_id: this.options.hostInstanceId,
				host_display_name: this.options.hostDisplayName,
				granted_capabilities: state.grantedCapabilities,
				sessions: sessions.map((session) => ({
					session_id: session.sessionId,
					title: session.title ?? "",
					running: session.running,
					updated_at_ms: String(session.updatedAt),
					workspace_label: session.workspaceLabel ?? "",
					pending_approval_count: session.pendingApprovalCount,
					pending_input_count: session.pendingInputCount,
					...sessionUsageWire(session.usage) === void 0 ? {} : { usage: sessionUsageWire(session.usage) },
					...session.parentSessionId === void 0 ? {} : { parent_session_id: session.parentSessionId },
					...session.origin === void 0 ? {} : { origin: session.origin },
					...subagentViewWire(session.subagent) === void 0 ? {} : { subagent: subagentViewWire(session.subagent) },
					...session.agentPreset === void 0 ? {} : { agent_preset: session.agentPreset },
					...modelSelectionWire(session.model) === void 0 ? {} : { model: modelSelectionWire(session.model) },
					...session.projectLabel === void 0 ? {} : { project_label: session.projectLabel }
				})),
				agent_presets: presets.map((preset) => ({
					id: preset.id,
					trust: preset.trust === "user" ? "TRUST_USER" : "TRUST_SYSTEM",
					is_default: preset.isDefault,
					...preset.name === void 0 ? {} : { name: preset.name },
					...preset.description === void 0 ? {} : { description: preset.description },
					...preset.broken === void 0 ? {} : { broken: preset.broken }
				})),
				model_catalog: catalog.groups.map((group) => ({
					id: group.id,
					...group.name === void 0 ? {} : { name: group.name },
					models: group.models.map((entry) => ({
						id: entry.id,
						...entry.name === void 0 ? {} : { name: entry.name },
						reasoning_efforts: entry.reasoningEfforts,
						...entry.defaultReasoningEffort === void 0 ? {} : { default_reasoning_effort: entry.defaultReasoningEffort },
						...entry.inputModalities === void 0 ? {} : { input_modalities: entry.inputModalities }
					}))
				})),
				model_catalog_failures: catalog.failures.map((failure) => ({
					provider_id: failure.providerId,
					...failure.detail === void 0 ? {} : { detail: failure.detail }
				})),
				artifacts,
				...this.options.blobs?.attachmentLimits === void 0 ? {} : { attachment_limits: {
					max_image_bytes: String(this.options.blobs.attachmentLimits.maxImageBytes),
					max_images_per_message: this.options.blobs.attachmentLimits.maxImagesPerMessage,
					media_types: [...this.options.blobs.attachmentLimits.mediaTypes]
				} },
				workspaces: workspaces.map((workspace) => ({
					workspace_id: workspace.workspaceId,
					label: workspace.label
				}))
			} }));
			return;
		}
		if (!state.helloComplete) {
			this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", "hello required");
			return;
		}
		if (message.subscribe !== void 0) await this.#subscribe(state, message.subscribe);
		else if (message.ack !== void 0) this.#ack(state, message.ack);
		else if (message.command !== void 0) this.#track(this.#command(state, message.command));
		else if (message.control_request !== void 0) await this.#control(state, message.control_request);
		else if (message.blob_begin !== void 0) await this.#blobBegin(state, message.blob_begin);
		else if (message.blob_chunk !== void 0) await this.#blobChunk(state, message.blob_chunk);
		else if (message.blob_control !== void 0) await this.#blobControl(state, message.blob_control);
		else if (message.blob_fetch !== void 0) await this.#blobFetch(state, message.blob_fetch);
		else if (message.heartbeat !== void 0) {
			const nonce = message.heartbeat.nonce;
			if (typeof nonce !== "string" || !remoteIdentifierPattern.test(nonce)) {
				this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", "heartbeat nonce required");
				return;
			}
			state.call.write(serverFrame({ heartbeat_ack: { nonce } }));
		} else this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", "unknown client frame");
	}
	/** Upload fence: session-input capability, transfer-scoped on denial (S-blob). */
	#blobUploadAuthorized(state) {
		try {
			this.#requireAuthorization(state, "68");
			return true;
		} catch {
			return false;
		}
	}
	#writeBlobTransferResult(state, result) {
		state.call.write(serverFrame({ blob_transfer_result: result }));
	}
	/** Refuse one upload frame with a transfer-scoped error; the carrier lives on. */
	#blobTransferRefusal(state, transferId, code, detail) {
		this.#writeBlobTransferResult(state, {
			transfer_id: typeof transferId === "string" ? transferId : "",
			received_bytes: "0",
			error: {
				code,
				detail
			}
		});
	}
	/** Refuse one fetch frame with a fetch-scoped error; the carrier lives on. */
	#blobFetchRefusal(state, fetchId, code, detail) {
		state.call.write(serverFrame({ blob_fetch_result: {
			fetch_id: typeof fetchId === "string" ? fetchId : "",
			error: {
				code,
				detail
			}
		} }));
	}
	async #blobBegin(state, begin) {
		const transferId = begin.transfer_id;
		if (!this.#blobUploadAuthorized(state)) {
			this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_UNAUTHORIZED", "The authenticated device is not authorized to send session input");
			return;
		}
		const assembler = this.options.blobs?.assembler;
		if (assembler === void 0) {
			this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_COMMIT_REJECTED", "blob uploads are not enabled in this Host composition");
			return;
		}
		const mediaType = begin.media_type === null ? void 0 : begin.media_type;
		const totalText = begin.total_bytes;
		const totalBytes = typeof totalText === "string" && uint64Pattern.test(totalText) && BigInt(totalText) >= 1n && BigInt(totalText) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(totalText) : void 0;
		if (typeof transferId !== "string" || !BLOB_TRANSFER_ID_PATTERN.test(transferId) || typeof begin.sha256_hex !== "string" || !BLOB_SHA256_PATTERN.test(begin.sha256_hex) || totalBytes === void 0 || mediaType !== void 0 && !remoteIdentifierPattern.test(mediaType)) {
			this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_INVALID_DECLARATION", "transfer_id, sha256_hex, a positive canonical total_bytes, and an optional bounded media_type are required");
			return;
		}
		try {
			const cursor = await assembler.begin({
				transferId,
				sha256Hex: begin.sha256_hex,
				totalBytes,
				...mediaType === void 0 ? {} : { mediaType }
			});
			this.#writeBlobTransferResult(state, {
				transfer_id: transferId,
				received_bytes: String(cursor.receivedBytes)
			});
		} catch (error) {
			if (!(error instanceof BlobTransferError)) throw error;
			this.#writeBlobTransferResult(state, {
				transfer_id: transferId,
				received_bytes: "0",
				error: blobTransferErrorWire(error)
			});
		}
	}
	async #blobChunk(state, chunk) {
		const transferId = chunk.transfer_id;
		if (!this.#blobUploadAuthorized(state)) {
			this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_UNAUTHORIZED", "The authenticated device is not authorized to send session input");
			return;
		}
		const assembler = this.options.blobs?.assembler;
		if (assembler === void 0) {
			this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_COMMIT_REJECTED", "blob uploads are not enabled in this Host composition");
			return;
		}
		const offsetText = chunk.offset;
		const offset = typeof offsetText === "string" && uint64Pattern.test(offsetText) && BigInt(offsetText) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(offsetText) : void 0;
		const data = chunk.data;
		if (typeof transferId !== "string" || !BLOB_TRANSFER_ID_PATTERN.test(transferId) || offset === void 0 || data === void 0 || data.length === 0) {
			this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_INVALID_DECLARATION", "transfer_id, a canonical offset, and non-empty chunk data are required");
			return;
		}
		try {
			const cursor = await assembler.chunk(transferId, offset, data);
			this.#writeBlobTransferResult(state, {
				transfer_id: transferId,
				received_bytes: String(cursor.receivedBytes)
			});
		} catch (error) {
			if (!(error instanceof BlobTransferError)) throw error;
			this.#writeBlobTransferResult(state, {
				transfer_id: transferId,
				received_bytes: "0",
				error: blobTransferErrorWire(error)
			});
		}
	}
	async #blobControl(state, control) {
		const transferId = control.transfer_id;
		if (!this.#blobUploadAuthorized(state)) {
			this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_UNAUTHORIZED", "The authenticated device is not authorized to send session input");
			return;
		}
		const assembler = this.options.blobs?.assembler;
		if (assembler === void 0) {
			this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_COMMIT_REJECTED", "blob uploads are not enabled in this Host composition");
			return;
		}
		if (typeof transferId !== "string" || !BLOB_TRANSFER_ID_PATTERN.test(transferId)) {
			this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_INVALID_DECLARATION", "a valid transfer_id is required");
			return;
		}
		try {
			switch (control.action) {
				case "BLOB_TRANSFER_ACTION_COMPLETE": {
					const committed = await assembler.complete(transferId);
					this.#writeBlobTransferResult(state, {
						transfer_id: transferId,
						received_bytes: "0",
						blob_id: committed.blobId
					});
					return;
				}
				case "BLOB_TRANSFER_ACTION_ABORT":
					await assembler.abort(transferId);
					this.#writeBlobTransferResult(state, {
						transfer_id: transferId,
						received_bytes: "0"
					});
					return;
				case "BLOB_TRANSFER_ACTION_STATUS": {
					const cursor = await assembler.status(transferId);
					if (cursor === void 0) {
						this.#writeBlobTransferResult(state, {
							transfer_id: transferId,
							received_bytes: "0",
							error: {
								code: "BLOB_TRANSFER_ERROR_UNKNOWN_TRANSFER",
								detail: "the transfer is unknown or already settled"
							}
						});
						return;
					}
					this.#writeBlobTransferResult(state, {
						transfer_id: transferId,
						received_bytes: String(cursor.receivedBytes)
					});
					return;
				}
				default: this.#blobTransferRefusal(state, transferId, "BLOB_TRANSFER_ERROR_INVALID_DECLARATION", "a known blob control action is required");
			}
		} catch (error) {
			if (!(error instanceof BlobTransferError)) throw error;
			this.#writeBlobTransferResult(state, {
				transfer_id: transferId,
				received_bytes: "0",
				error: blobTransferErrorWire(error)
			});
		}
	}
	async #blobFetch(state, fetch) {
		const fetchId = fetch.fetch_id;
		const server = this.options.blobs?.fetch;
		if (server === void 0) {
			this.#blobFetchRefusal(state, fetchId, "BLOB_FETCH_ERROR_INVALID_REQUEST", "blob fetches are not enabled in this Host composition");
			return;
		}
		if (typeof fetchId !== "string" || !BLOB_TRANSFER_ID_PATTERN.test(fetchId)) {
			this.#blobFetchRefusal(state, fetchId, "BLOB_FETCH_ERROR_INVALID_REQUEST", "fetch_id must be client-minted lowercase hex");
			return;
		}
		const open = fetch.open;
		if (open !== void 0 && open !== null) {
			const sessionId = open.session_id;
			const attachmentId = open.attachment_id;
			const artifactId = open.artifact_id;
			const hasAttachment = typeof attachmentId === "string" && attachmentId !== "";
			const hasArtifact = typeof artifactId === "string" && artifactId !== "";
			if (typeof sessionId !== "string" || !validSessionId(sessionId) || hasAttachment === hasArtifact) {
				this.#blobFetchRefusal(state, fetchId, "BLOB_FETCH_ERROR_INVALID_REQUEST", "a valid session_id and exactly one fetch source are required");
				return;
			}
			const source = hasAttachment ? {
				kind: "attachment",
				attachmentId,
				sessionId
			} : {
				kind: "artifact",
				artifactId,
				sessionId
			};
			try {
				const opened = await server.open({
					fetchId,
					source
				});
				state.call.write(serverFrame({ blob_fetch_result: {
					fetch_id: fetchId,
					opened: {
						total_bytes: String(opened.totalBytes),
						...opened.sha256Hex === void 0 ? {} : { sha256_hex: opened.sha256Hex },
						...opened.mediaType === void 0 ? {} : { media_type: opened.mediaType }
					}
				} }));
			} catch (error) {
				if (!(error instanceof BlobFetchError)) throw error;
				const wire = blobFetchErrorWire(error);
				this.#blobFetchRefusal(state, fetchId, wire.code, wire.detail);
			}
			return;
		}
		const offsetText = fetch.chunk_offset;
		const offset = typeof offsetText === "string" && uint64Pattern.test(offsetText) && BigInt(offsetText) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(offsetText) : void 0;
		if (offset === void 0) {
			this.#blobFetchRefusal(state, fetchId, "BLOB_FETCH_ERROR_INVALID_REQUEST", "blob_fetch requires open or a canonical chunk_offset");
			return;
		}
		try {
			const chunk = await server.chunk(fetchId, offset, BLOB_CHUNK_BYTES);
			state.call.write(serverFrame({ blob_fetch_result: {
				fetch_id: fetchId,
				chunk: {
					offset: String(chunk.offset),
					data: Buffer.from(chunk.data),
					complete: chunk.complete
				}
			} }));
		} catch (error) {
			if (!(error instanceof BlobFetchError)) throw error;
			const wire = blobFetchErrorWire(error);
			this.#blobFetchRefusal(state, fetchId, wire.code, wire.detail);
		}
	}
	/**
	* The policy owner's current budget admission decision (S-policy). `false`
	* covers every unevaluable case — no owner, no budget, no usage meter —
	* because an exhaustion claim without an evaluation would be dishonest.
	*/
	#budgetExhausted(sessionId) {
		try {
			return this.options.policy?.()?.evaluateBudget(sessionId)?.exhausted === true;
		} catch {
			return false;
		}
	}
	async #subscribe(state, subscription) {
		const sessionId = subscription.session_id;
		if (typeof sessionId !== "string" || sessionId === "") {
			this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", "session_id required");
			return;
		}
		if (subscription.resume !== void 0 && subscription.force_fresh_snapshot !== true) {
			await this.#resume(state, sessionId, subscription.resume);
			return;
		}
		state.setupAbort?.abort();
		delete state.setupAbort;
		if (state.generation !== void 0) await state.generation.detach(state.delivery);
		delete state.generation;
		const abort = new AbortController();
		state.setupAbort = abort;
		state.subscribed = false;
		state.sessionId = sessionId;
		delete state.streamId;
		const queue = new AsyncFrameQueue();
		const pump = this.#track((async () => {
			try {
				for await (const frame of this.source.watch(sessionId, abort.signal)) queue.push(frame);
			} finally {
				queue.close();
			}
		})());
		try {
			const history = await this.source.history(sessionId, this.options.maxHistoryMessages);
			const cwd = this.options.artifacts === void 0 ? void 0 : await this.source.sessionCwd(sessionId);
			const baseline = projectSnapshot({
				sessionId,
				running: history.running,
				...history.title === void 0 ? {} : { title: history.title },
				...history.usage === void 0 ? {} : { usage: history.usage },
				...history.subagent === void 0 ? {} : { subagent: history.subagent },
				...history.agentPreset === void 0 ? {} : { agentPreset: history.agentPreset },
				...history.model === void 0 ? {} : { model: history.model },
				...history.policy === void 0 ? {} : { policy: history.policy },
				budgetExhausted: this.#budgetExhausted(sessionId),
				entries: history.entries,
				historyTruncated: history.hasMore,
				sourceWatermark: history.sourceWatermark,
				projectionWatermark: history.projectionWatermark,
				maxToolContentChars: this.options.maxToolContentChars,
				approvals: history.approvals,
				pendingInputCount: history.pendingInputCount,
				...cwd === void 0 ? {} : { cwd }
			});
			if (state.closed) throw new Error("connection closed during subscription setup");
			const streamId = randomUUID();
			const generation = this.#cursors.create(streamId, {
				sessionId,
				...state.domain,
				projectionVersion: 8
			}, abort, state.delivery);
			state.generation = generation;
			state.streamId = streamId;
			delete state.setupAbort;
			if (!state.delivery.write({ snapshot: {
				stream_id: streamId,
				projection_version: 8,
				snapshot_end_sequence: "0",
				session: baseline.session
			} })) {
				state.delivery.backpressure();
				await generation.detach(state.delivery);
				state.subscribed = false;
				return;
			}
			state.subscribed = true;
			this.#track(this.#drainLive(state, generation, queue, abort, baseline, cwd === void 0 ? {} : { cwd })).catch((cause) => {
				if (abort.signal.aborted) return;
				generation.invalidate({ error: {
					code: "ERROR_CODE_INVALID_REQUEST",
					detail: cause instanceof Error ? cause.message : String(cause),
					retryable: true
				} });
				if (state.generation === generation) state.subscribed = false;
			});
		} catch (cause) {
			abort.abort();
			await pump;
			if (cause instanceof RemoteReadError && cause.code === "session-not-found") this.#writeError(state, "ERROR_CODE_SESSION_NOT_FOUND", cause.message);
			else this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", cause instanceof Error ? cause.message : String(cause), true);
		}
	}
	async #resume(state, sessionId, cursor) {
		const streamId = cursor.stream_id;
		const sequenceText = cursor.highest_contiguous_sequence;
		if (typeof streamId !== "string" || streamId === "" || typeof cursor.projection_version !== "number" || typeof sequenceText !== "string" || !/^(0|[1-9]\d*)$/.test(sequenceText)) {
			this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", "complete resume cursor required");
			return;
		}
		const highestContiguousSequence = BigInt(sequenceText);
		if (highestContiguousSequence > 18446744073709551615n) {
			this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", "resume sequence exceeds uint64");
			return;
		}
		const priorGeneration = state.generation;
		if (priorGeneration !== void 0 && priorGeneration.streamId !== streamId) {
			await priorGeneration.detach(state.delivery);
			if (state.generation === priorGeneration) {
				delete state.generation;
				state.subscribed = false;
			}
		}
		if (state.closed) return;
		const result = await this.#cursors.resume({
			sessionId,
			...state.domain,
			projectionVersion: 8
		}, {
			streamId,
			projectionVersion: cursor.projection_version,
			highestContiguousSequence
		}, state.delivery);
		if (!result.accepted) {
			const detail = {
				"generation-unavailable": "resume generation is unavailable in this Host process",
				"domain-changed": "resume session, device authority, or projection changed",
				"cursor-ahead": "resume cursor is ahead of the retained generation",
				"cursor-too-old": "resume cursor fell behind retained events"
			}[result.reason];
			this.#writeError(state, "ERROR_CODE_SNAPSHOT_REQUIRED", detail, true);
			return;
		}
		if (!state.delivery.active()) {
			await result.generation.detach(state.delivery);
			return;
		}
		state.setupAbort?.abort();
		delete state.setupAbort;
		if (state.generation !== result.generation && state.generation !== void 0) await state.generation.detach(state.delivery);
		state.generation = result.generation;
		state.sessionId = sessionId;
		state.streamId = streamId;
		state.subscribed = true;
	}
	async #drainLive(state, generation, queue, abort, baseline, sessionFacts) {
		while (!abort.signal.aborted) {
			const next = await queue.next();
			if (next.done) return;
			const frame = next.value;
			if (frame.type === "session/subscribed") continue;
			if (frame.type === "approval/requested" || frame.type === "approval/resolved") {
				await generation.append(projectApprovalFrame(frame, this.options.maxToolContentChars));
				continue;
			}
			if (frame.type === "question/attention") {
				await generation.append(projectInputAttentionFrame(frame));
				continue;
			}
			if (frame.type === "session/projection") {
				if (frame.seq <= baseline.projectionWatermark) continue;
				if (frame.key === "title" && typeof frame.value === "string") {
					await generation.append({
						event_id: `source-projection-title-${frame.seq}`,
						source_sequence: String(frame.seq),
						session_title_changed: { title: frame.value }
					});
					continue;
				}
				const usagePayload = projectUsageFrame(frame);
				if (usagePayload !== null) await generation.append(usagePayload);
				const subagentPayload = projectSubagentFrame(frame);
				if (subagentPayload !== null) await generation.append(subagentPayload);
				const policyPayload = projectPolicyFrame(frame, this.#budgetExhausted(state.sessionId));
				if (policyPayload !== null) await generation.append(policyPayload);
				continue;
			}
			if (frame.event.seq <= baseline.sourceWatermark) continue;
			const projected = projectLiveFrame({
				event: frame.event,
				...frame.view === void 0 ? {} : { view: frame.view },
				toolNames: baseline.toolNames,
				maxToolContentChars: this.options.maxToolContentChars,
				...sessionFacts.cwd === void 0 ? {} : { cwd: sessionFacts.cwd }
			});
			if (projected.kind === "ignore") continue;
			if (projected.kind === "snapshot-required") {
				await generation.invalidate({ error: {
					code: "ERROR_CODE_SNAPSHOT_REQUIRED",
					detail: projected.detail,
					retryable: true
				} });
				state.subscribed = false;
				return;
			}
			await generation.append(projected.payload);
			const registered = this.options.artifacts?.observeLive({
				sessionId: state.sessionId,
				...sessionFacts.cwd === void 0 ? {} : { cwd: sessionFacts.cwd },
				event: frame.event,
				...frame.view === void 0 ? {} : { view: frame.view }
			}) ?? [];
			for (const artifact of registered) await generation.append({
				event_id: `artifact-${artifact.artifact_id}`,
				source_sequence: String(frame.event.seq),
				artifact_registered: { artifact }
			});
		}
	}
	#ack(state, ack) {
		const generation = state.generation;
		if (!state.subscribed || generation === void 0) {
			this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", "subscription required");
			return;
		}
		const sequenceText = ack.highest_contiguous_sequence;
		if (ack.stream_id !== state.streamId || ack.projection_version !== 8 || typeof sequenceText !== "string" || !/^(0|[1-9]\d*)$/.test(sequenceText) || BigInt(sequenceText) > generation.latestSequence) this.#writeError(state, "ERROR_CODE_SNAPSHOT_REQUIRED", "ack domain changed", true);
	}
	async #control(state, request) {
		const requestId = request.request_id;
		const sessionId = request.session_id;
		if (typeof requestId !== "string" || !remoteIdentifierPattern.test(requestId) || !validSessionId(sessionId)) {
			this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", "control request_id and session_id required");
			return;
		}
		if ([
			request.acquire,
			request.renew,
			request.release
		].filter((operation) => operation !== void 0).length !== 1) {
			this.#writeControlResult(state, requestId, sessionId, "CONTROL_OUTCOME_REJECTED", {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "exactly one control operation required"
			});
			return;
		}
		const control = this.options.control?.();
		if (control === void 0) {
			this.#writeControlResult(state, requestId, sessionId, "CONTROL_OUTCOME_REJECTED", {
				code: "ERROR_CODE_EFFECTFUL_COMMANDS_DISABLED",
				detail: "Session control is not enabled in this Host composition"
			});
			return;
		}
		try {
			this.#requireAuthorization(state, "64");
		} catch {
			this.#writeControlResult(state, requestId, sessionId, "CONTROL_OUTCOME_REJECTED", {
				code: "ERROR_CODE_AUTHORIZATION_DENIED",
				detail: "The authenticated device is not authorized for Session control"
			});
			return;
		}
		const deviceId = state.deviceId.toString("hex");
		try {
			if (request.acquire !== void 0) {
				const result = await control.acquireControl(sessionId, deviceId);
				if (!result.ok) {
					this.#writeControlResult(state, requestId, sessionId, "CONTROL_OUTCOME_REJECTED", controlFailure(result.reason));
					return;
				}
				this.#writeControlLease(state, requestId, "CONTROL_OUTCOME_ACQUIRED", result.lease);
				return;
			}
			const rawFence = request.renew?.control ?? request.release?.control;
			const proof = this.#controlProof(sessionId, deviceId, rawFence);
			if (proof === void 0) {
				this.#writeControlResult(state, requestId, sessionId, "CONTROL_OUTCOME_REJECTED", {
					code: "ERROR_CODE_INVALID_REQUEST",
					detail: "complete canonical control fence required"
				});
				return;
			}
			if (request.renew !== void 0) {
				const result = await control.renewControl(proof);
				if (!result.ok) {
					this.#writeControlResult(state, requestId, sessionId, "CONTROL_OUTCOME_REJECTED", controlFailure(result.reason));
					return;
				}
				this.#writeControlLease(state, requestId, "CONTROL_OUTCOME_RENEWED", result.lease);
				return;
			}
			const result = await control.releaseControl(proof);
			if (!result.ok) {
				this.#writeControlResult(state, requestId, sessionId, "CONTROL_OUTCOME_REJECTED", controlFailure(result.reason));
				return;
			}
			this.#writeControlResult(state, requestId, sessionId, "CONTROL_OUTCOME_RELEASED");
		} catch {
			this.#writeControlResult(state, requestId, sessionId, "CONTROL_OUTCOME_REJECTED", {
				code: "ERROR_CODE_CONTROL_UNAVAILABLE",
				detail: "The Host control owner is temporarily unavailable"
			});
		}
	}
	async #command(state, command) {
		const commandId = command.command_id;
		if (typeof commandId !== "string" || !remoteIdentifierPattern.test(commandId)) {
			this.#writeError(state, "ERROR_CODE_INVALID_REQUEST", "command_id required");
			return;
		}
		const sessionId = command.session_id;
		const text = command.send_input?.text;
		const stopRevisionText = command.stop_active?.expected_activity_revision;
		const approval = command.decide_approval;
		const create = command.create_session;
		const selectPreset = command.select_agent_preset;
		const selectModel = command.select_model;
		const fork = command.fork_session;
		const revoke = command.revoke_approval_rule;
		const budget = command.set_session_budget;
		const operations = [
			command.send_input,
			command.stop_active,
			approval,
			create,
			selectPreset,
			selectModel,
			fork,
			revoke,
			budget
		].filter((operation) => operation !== void 0);
		if (!validSessionId(sessionId) || operations.length !== 1) {
			this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "session_id and exactly one command operation required"
			});
			return;
		}
		const stopping = command.stop_active !== void 0;
		const deciding = approval !== void 0;
		const creating = create !== void 0;
		const selecting = selectPreset !== void 0;
		const selectingModel = selectModel !== void 0;
		const forking = fork !== void 0;
		const revoking = revoke !== void 0;
		const budgeting = budget !== void 0;
		const presetIdPattern = /^[\x21-\x7e]{1,100}$/;
		const modelIdPattern = /^[\x21-\x7e]{1,200}$/;
		const ruleIdPattern = /^[0-9a-f]{16,64}$/;
		const createAgentPreset = create?.agent_preset;
		const createWorkspaceId = create?.workspace_id;
		const createNewWorkspaceName = create?.new_workspace_name;
		const selectAgentPreset = selectPreset?.agent_preset;
		const modelProvider = selectModel?.provider;
		const modelId = selectModel?.model;
		const modelEffort = selectModel?.reasoning_effort;
		const forkChildId = fork?.child_session_id;
		const forkAtSeq = fork?.at_seq;
		const revokeRuleId = revoke?.rule_id;
		const budgetCeilingText = budget?.max_total_tokens;
		const approvalDecision = approval?.decision;
		const approvalOutcome = approvalDecision === "APPROVAL_DECISION_ALLOW_ONCE" || approvalDecision === "APPROVAL_DECISION_ALLOW_SAME_KIND" ? "allowed-once" : approvalDecision === "APPROVAL_DECISION_DENY" ? "rejected" : void 0;
		const grantSameKind = approvalDecision === "APPROVAL_DECISION_ALLOW_SAME_KIND";
		if (!stopping && !deciding && !creating && !selecting && !selectingModel && !forking && !revoking && !budgeting && (typeof text !== "string" || text === "") || stopping && (typeof stopRevisionText !== "string" || !uint64Pattern.test(stopRevisionText) || BigInt(stopRevisionText) > BigInt(Number.MAX_SAFE_INTEGER) || stopRevisionText === "0") || deciding && (typeof approval.approval_id !== "string" || !remoteIdentifierPattern.test(approval.approval_id) || typeof approval.revision !== "string" || !remoteIdentifierPattern.test(approval.revision) || approvalOutcome === void 0) || creating && createAgentPreset !== void 0 && (typeof createAgentPreset !== "string" || !presetIdPattern.test(createAgentPreset)) || creating && createWorkspaceId !== void 0 && (typeof createWorkspaceId !== "string" || !presetIdPattern.test(createWorkspaceId)) || creating && createNewWorkspaceName !== void 0 && (typeof createNewWorkspaceName !== "string" || sanitizeRemoteWorkspaceName(createNewWorkspaceName) === void 0) || creating && createNewWorkspaceName !== void 0 && createWorkspaceId === void 0 || selecting && (typeof selectAgentPreset !== "string" || !presetIdPattern.test(selectAgentPreset)) || selectingModel && (typeof modelProvider !== "string" || !presetIdPattern.test(modelProvider) || typeof modelId !== "string" || !modelIdPattern.test(modelId) || modelEffort !== void 0 && (typeof modelEffort !== "string" || !presetIdPattern.test(modelEffort))) || forking && (typeof forkChildId !== "string" || !validSessionId(forkChildId) || forkAtSeq !== void 0 && (typeof forkAtSeq !== "string" || !uint64Pattern.test(forkAtSeq) || BigInt(forkAtSeq) > BigInt(Number.MAX_SAFE_INTEGER))) || revoking && (typeof revokeRuleId !== "string" || !ruleIdPattern.test(revokeRuleId)) || budgeting && (typeof budgetCeilingText !== "string" || !uint64Pattern.test(budgetCeilingText) || budgetCeilingText === "0" || BigInt(budgetCeilingText) > BigInt(Number.MAX_SAFE_INTEGER))) {
			if (stopping) this.#writeStopResult(state, commandId, sessionId, "0", "STOP_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "positive canonical expected_activity_revision required"
			});
			else if (creating) {
				const workspaceShape = createNewWorkspaceName !== void 0 && createWorkspaceId === void 0 || createNewWorkspaceName !== void 0 && sanitizeRemoteWorkspaceName(String(createNewWorkspaceName ?? "")) === void 0 || createWorkspaceId !== void 0 && (typeof createWorkspaceId !== "string" || !presetIdPattern.test(createWorkspaceId));
				this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
					code: workspaceShape ? "ERROR_CODE_WORKSPACE_INVALID_NAME" : "ERROR_CODE_INVALID_REQUEST",
					detail: workspaceShape ? "new_workspace_name must be a single folder name under an existing workspace" : "a bounded printable agent_preset id is required"
				});
			} else if (selecting) this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "a bounded printable agent_preset id is required"
			});
			else if (selectingModel) this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "bounded printable provider and model ids are required"
			});
			else if (forking) this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "a valid child_session_id and optional canonical at_seq are required"
			});
			else if (revoking) this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "a canonical hex rule_id is required"
			});
			else if (budgeting) this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "a positive canonical max_total_tokens ceiling is required"
			});
			else if (!deciding) this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "non-empty send_input.text required"
			});
			else this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "complete approval identity, revision, and decision required"
			});
			return;
		}
		const attachmentIds = command.send_input?.attachment_ids ?? [];
		if (attachmentIds.some((id) => typeof id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(id))) {
			this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "attachment_ids must be committed sha256 image ids"
			});
			return;
		}
		if (attachmentIds.length > 0) {
			const limits = this.options.blobs?.attachmentLimits;
			if (limits === void 0) {
				this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
					code: "ERROR_CODE_ATTACHMENT_UNAVAILABLE",
					detail: "this deployment accepts no image attachments"
				});
				return;
			}
			if (attachmentIds.length > limits.maxImagesPerMessage) {
				this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, {
					code: "ERROR_CODE_ATTACHMENT_UNAVAILABLE",
					detail: `at most ${limits.maxImagesPerMessage} images per message`
				});
				return;
			}
		}
		const commands = this.options.commands?.();
		if (commands === void 0) {
			const error = {
				code: "ERROR_CODE_EFFECTFUL_COMMANDS_DISABLED",
				detail: "effectful commands are not enabled in this Host composition"
			};
			if (stopping) this.#writeStopResult(state, commandId, sessionId, stopRevisionText, "STOP_OUTCOME_REJECTED", false, error);
			else this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, error);
			return;
		}
		const deviceId = state.deviceId.toString("hex");
		const leaseFree = deciding || creating || selecting || forking || revoking || budgeting;
		const control = leaseFree ? void 0 : this.#controlProof(sessionId, deviceId, command.control);
		if (!leaseFree && control === void 0) {
			const error = {
				code: "ERROR_CODE_INVALID_REQUEST",
				detail: "complete canonical command control fence required"
			};
			if (stopping) this.#writeStopResult(state, commandId, sessionId, stopRevisionText, "STOP_OUTCOME_REJECTED", false, error);
			else this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, error);
			return;
		}
		const requiredCapabilities = deciding || revoking ? "16" : stopping ? "72" : "68";
		const authority = Object.freeze({
			deviceId,
			authorityEpoch: state.domain.authorityEpoch,
			authorize: () => {
				this.#requireAuthorization(state, requiredCapabilities);
			}
		});
		try {
			authority.authorize();
		} catch {
			const error = {
				code: "ERROR_CODE_AUTHORIZATION_DENIED",
				detail: stopping ? "The authenticated device is not authorized to Stop" : deciding ? "The authenticated device is not authorized to decide approvals" : "The authenticated device is not authorized for this command"
			};
			if (stopping) this.#writeStopResult(state, commandId, sessionId, stopRevisionText, "STOP_OUTCOME_REJECTED", false, error);
			else this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_REJECTED", false, error);
			return;
		}
		try {
			if (creating) {
				const boundName = typeof createNewWorkspaceName === "string" ? sanitizeRemoteWorkspaceName(createNewWorkspaceName) : void 0;
				const terminal = await commands.createSession(authority, {
					commandId,
					sessionId,
					...createAgentPreset === void 0 ? {} : { agentPreset: createAgentPreset },
					...createWorkspaceId === void 0 ? {} : { workspaceId: createWorkspaceId },
					...boundName === void 0 ? {} : { newWorkspaceName: boundName }
				}, (receipt) => {
					this.#writeCommandResult(state, receipt.commandId, "COMMAND_OUTCOME_RECEIVED", receipt.replayed);
				});
				if (terminal.outcome === "committed") {
					this.#writeCommandResult(state, terminal.commandId, "COMMAND_OUTCOME_COMMITTED", terminal.replayed);
					return;
				}
				this.#writeCommandResult(state, terminal.commandId, terminal.outcome === "rejected" ? "COMMAND_OUTCOME_REJECTED" : "COMMAND_OUTCOME_UNKNOWN", terminal.replayed, commandError(terminal));
				return;
			}
			if (selecting) {
				const terminal = await commands.selectAgentPreset(authority, {
					commandId,
					sessionId,
					agentPreset: selectAgentPreset
				}, (receipt) => {
					this.#writeCommandResult(state, receipt.commandId, "COMMAND_OUTCOME_RECEIVED", receipt.replayed);
				});
				if (terminal.outcome === "committed") {
					this.#writeCommandResult(state, terminal.commandId, "COMMAND_OUTCOME_COMMITTED", terminal.replayed);
					return;
				}
				this.#writeCommandResult(state, terminal.commandId, terminal.outcome === "rejected" ? "COMMAND_OUTCOME_REJECTED" : "COMMAND_OUTCOME_UNKNOWN", terminal.replayed, commandError(terminal));
				return;
			}
			if (selectingModel) {
				const terminal = await commands.selectModel(authority, {
					commandId,
					sessionId,
					provider: modelProvider,
					model: modelId,
					...modelEffort === void 0 ? {} : { reasoningEffort: modelEffort },
					control
				}, (receipt) => {
					this.#writeCommandResult(state, receipt.commandId, "COMMAND_OUTCOME_RECEIVED", receipt.replayed);
				});
				if (terminal.outcome === "committed") {
					this.#writeCommandResult(state, terminal.commandId, "COMMAND_OUTCOME_COMMITTED", terminal.replayed);
					return;
				}
				this.#writeCommandResult(state, terminal.commandId, terminal.outcome === "rejected" ? "COMMAND_OUTCOME_REJECTED" : "COMMAND_OUTCOME_UNKNOWN", terminal.replayed, commandError(terminal));
				return;
			}
			if (forking) {
				const terminal = await commands.forkSession(authority, {
					commandId,
					sessionId,
					childSessionId: forkChildId,
					...forkAtSeq === void 0 ? {} : { atSeq: Number(forkAtSeq) }
				}, (receipt) => {
					this.#writeCommandResult(state, receipt.commandId, "COMMAND_OUTCOME_RECEIVED", receipt.replayed);
				});
				if (terminal.outcome === "committed") {
					this.#writeCommandResult(state, terminal.commandId, "COMMAND_OUTCOME_COMMITTED", terminal.replayed);
					return;
				}
				this.#writeCommandResult(state, terminal.commandId, terminal.outcome === "rejected" ? "COMMAND_OUTCOME_REJECTED" : "COMMAND_OUTCOME_UNKNOWN", terminal.replayed, commandError(terminal));
				return;
			}
			if (revoking) {
				const terminal = await commands.revokeApprovalRule(authority, {
					commandId,
					sessionId,
					ruleId: revokeRuleId
				}, (receipt) => {
					this.#writeCommandResult(state, receipt.commandId, "COMMAND_OUTCOME_RECEIVED", receipt.replayed);
				});
				if (terminal.outcome === "committed") {
					this.#writeCommandResult(state, terminal.commandId, "COMMAND_OUTCOME_COMMITTED", terminal.replayed);
					return;
				}
				this.#writeCommandResult(state, terminal.commandId, terminal.outcome === "rejected" ? "COMMAND_OUTCOME_REJECTED" : "COMMAND_OUTCOME_UNKNOWN", terminal.replayed, commandError(terminal));
				return;
			}
			if (budgeting) {
				const terminal = await commands.setSessionBudget(authority, {
					commandId,
					sessionId,
					maxTotalTokens: Number(budgetCeilingText)
				}, (receipt) => {
					this.#writeCommandResult(state, receipt.commandId, "COMMAND_OUTCOME_RECEIVED", receipt.replayed);
				});
				if (terminal.outcome === "committed") {
					this.#writeCommandResult(state, terminal.commandId, "COMMAND_OUTCOME_COMMITTED", terminal.replayed);
					return;
				}
				this.#writeCommandResult(state, terminal.commandId, terminal.outcome === "rejected" ? "COMMAND_OUTCOME_REJECTED" : "COMMAND_OUTCOME_UNKNOWN", terminal.replayed, commandError(terminal));
				return;
			}
			if (deciding) {
				const terminal = await commands.decideApproval(authority, {
					commandId,
					sessionId,
					approvalId: approval.approval_id,
					approvalRevision: approval.revision,
					outcome: approvalOutcome,
					...grantSameKind ? { grantSameKind: true } : {}
				}, (receipt) => {
					this.#writeCommandResult(state, receipt.commandId, "COMMAND_OUTCOME_RECEIVED", receipt.replayed);
				});
				if (terminal.outcome === "committed") {
					this.#writeCommandResult(state, terminal.commandId, "COMMAND_OUTCOME_COMMITTED", terminal.replayed);
					return;
				}
				const error = terminal.outcome === "unknown" ? {
					code: "ERROR_CODE_APPROVAL_SETTLEMENT_UNKNOWN",
					detail: "The Host cannot prove approval settlement; retry with the same command_id"
				} : commandError(terminal);
				this.#writeCommandResult(state, terminal.commandId, terminal.outcome === "rejected" ? "COMMAND_OUTCOME_REJECTED" : "COMMAND_OUTCOME_UNKNOWN", terminal.replayed, error);
				return;
			}
			if (stopping) {
				const expectedActivityRevision = Number(stopRevisionText);
				const terminal = await commands.stop(authority, {
					commandId,
					sessionId,
					expectedActivityRevision,
					control
				}, (receipt) => {
					this.#writeStopResult(state, receipt.commandId, sessionId, String(receipt.expectedActivityRevision), "STOP_OUTCOME_REQUESTED", receipt.replayed);
				});
				if (terminal.outcome === "stopped") {
					this.#writeStopResult(state, terminal.commandId, sessionId, String(terminal.expectedActivityRevision), "STOP_OUTCOME_STOPPED", terminal.replayed, void 0, terminal.currentRunning);
					return;
				}
				this.#writeStopResult(state, terminal.commandId, sessionId, String(terminal.expectedActivityRevision), terminal.outcome === "rejected" ? "STOP_OUTCOME_REJECTED" : "STOP_OUTCOME_UNKNOWN", terminal.replayed, stopError(terminal));
				return;
			}
			const terminal = await commands.sendInput(authority, {
				commandId,
				sessionId,
				text,
				...attachmentIds.length === 0 ? {} : { attachmentIds },
				control
			}, (receipt) => {
				this.#writeCommandResult(state, receipt.commandId, "COMMAND_OUTCOME_RECEIVED", receipt.replayed);
			});
			if (terminal.outcome === "committed") {
				this.#writeCommandResult(state, terminal.commandId, "COMMAND_OUTCOME_COMMITTED", terminal.replayed);
				return;
			}
			const error = commandError(terminal);
			this.#writeCommandResult(state, terminal.commandId, terminal.outcome === "rejected" ? "COMMAND_OUTCOME_REJECTED" : "COMMAND_OUTCOME_UNKNOWN", terminal.replayed, error);
		} catch {
			if (stopping) this.#writeStopResult(state, commandId, sessionId, stopRevisionText, "STOP_OUTCOME_UNKNOWN", false, {
				code: "ERROR_CODE_STOP_SETTLEMENT_UNKNOWN",
				detail: "The Host Stop owner failed after admission; reconcile with the same command_id"
			});
			else this.#writeCommandResult(state, commandId, "COMMAND_OUTCOME_UNKNOWN", false, {
				code: deciding ? "ERROR_CODE_APPROVAL_SETTLEMENT_UNKNOWN" : "ERROR_CODE_COMMAND_OUTCOME_UNKNOWN",
				detail: deciding ? "The Host approval owner failed after admission; retry with the same command_id" : "The Host command owner failed after admission; retry with the same command_id"
			});
		}
	}
	#controlProof(sessionId, deviceId, raw) {
		if (raw === void 0 || raw === null || typeof raw.epoch !== "string" || !uint64Pattern.test(raw.epoch) || BigInt(raw.epoch) > UINT64_MAX || typeof raw.token !== "string" || !controlTokenPattern.test(raw.token)) return void 0;
		return Object.freeze({
			sessionId,
			holderDeviceId: deviceId,
			epoch: raw.epoch,
			token: raw.token
		});
	}
	#requireAuthorization(state, requiredCapabilities) {
		const current = this.options.security.authorizeCapabilities(Buffer.from(state.domain.devicePublicKey, "hex"), requiredCapabilities);
		if (current.decision !== "allowed" || current.authorityEpoch !== state.domain.authorityEpoch || current.deviceId.length !== state.deviceId.length || !timingSafeEqual(current.deviceId, state.deviceId)) throw new Error("authenticated device authority changed or lacks capability");
	}
	#writeControlLease(state, requestId, outcome, lease) {
		this.#writeControlResult(state, requestId, lease.sessionId, outcome, void 0, lease);
	}
	#writeControlResult(state, requestId, sessionId, outcome, error, lease) {
		state.call.write(serverFrame({ control_result: {
			request_id: requestId,
			session_id: sessionId,
			outcome,
			...lease === void 0 ? {} : {
				control: {
					epoch: lease.epoch,
					token: lease.token
				},
				expires_at_ms: String(lease.expiresAtMs)
			},
			error_code: error?.code ?? "ERROR_CODE_UNSPECIFIED",
			detail: error?.detail ?? ""
		} }));
	}
	#writeCommandResult(state, commandId, outcome, replayed, error) {
		state.call.write(serverFrame({ command_result: {
			command_id: commandId,
			outcome,
			replayed,
			error_code: error?.code ?? "ERROR_CODE_UNSPECIFIED",
			detail: error?.detail ?? ""
		} }));
	}
	#writeStopResult(state, commandId, sessionId, expectedActivityRevision, outcome, replayed, error, currentRunning) {
		state.call.write(serverFrame({ stop_result: {
			command_id: commandId,
			session_id: sessionId,
			expected_activity_revision: expectedActivityRevision,
			outcome,
			replayed,
			current_running: currentRunning ?? false,
			current_running_known: currentRunning !== void 0,
			error_code: error?.code ?? "ERROR_CODE_UNSPECIFIED",
			detail: error?.detail ?? ""
		} }));
	}
	#writeError(state, code, detail, retryable = false) {
		state.call.write(serverFrame({ error: {
			code,
			detail,
			retryable
		} }));
	}
};
//#endregion
//#region src/host/index.ts
/**
* @deepseek-ai/dsh-host-remote — source-backed, read-only mobile projection
* carrier. It closes `ctx.apiProxy` over a capability-minimized port and exposes
* it only after the shared security core authenticates and authorizes a paired
* device. Effectful commands remain explicitly rejected.
* @module @deepseek-ai/dsh-host-remote
*/
/** Stable Cordis function-plugin name. */
const name = "host-remote";
/** The sole privileged dependency, narrowed before the carrier sees it. */
const inject = ["apiProxy"];
const Config = z.object({
	port: z.natural().max(65535).default(50051),
	maxHistoryMessages: z.number().step(1).min(1).max(1e3).default(200),
	maxToolContentChars: z.number().step(1).min(256).max(65536).default(8192),
	resumeRetentionTtlMs: z.number().step(1).min(100).max(3e5).default(3e4),
	maxRetainedEvents: z.number().step(1).min(1).max(1e4).default(512),
	maxRetainedJsonBytes: z.number().step(1).min(1024).max(67108864).default(2097152),
	maxRetainedGenerations: z.number().step(1).min(1).max(1024).default(64),
	securityAddonPath: z.string(),
	securityStorePath: z.string().required(),
	lanDiscovery: z.boolean().default(false),
	lanDisplayName: z.string(),
	lanAddress: z.string(),
	projects: z.array(z.object({
		root: z.string().min(1).max(1024),
		label: z.string().min(1).max(100)
	})).max(256).default([]),
	artifactScanSessions: z.number().step(1).min(1).max(100).default(20),
	artifactScanEvents: z.number().step(1).min(1).max(2e3).default(500),
	artifactRosterCap: z.number().step(1).min(1).max(1e3).default(100),
	blobStagingDir: z.string()
});
/**
* Start the authenticated carrier and join every stream plus the listener
* during plugin disposal. LAN advertisement follows the live `host-remote`
* settings section when one is registered.
*/
async function apply(ctx, config) {
	installApprovalPolicyOwner(ctx);
	const source = createRemoteProjectionReadPort(ctx.apiProxy, { projects: config.projects ?? [] });
	const port = config.port ?? 50051;
	const entry = hostRemoteSettingsEntry(config);
	let security;
	try {
		security = loadRemoteSecurityOwner(config.securityAddonPath, config.securityStorePath);
	} catch (error) {
		if (classifyRemoteSecurityLoadFailure(error, config.securityAddonPath) === void 0) throw error;
		ctx.logger.warn(`host-remote: ${error instanceof Error ? error.message : String(error)}`);
	}
	let settingsSource = () => entry;
	let appliedLan = entry;
	let lanRuntime;
	installSettingsSection(ctx, HOST_REMOTE_SETTINGS_NAMESPACE, HOST_REMOTE_SETTINGS_SCHEMA, entry, {
		validate: (value) => {
			validateHostRemoteSettings(value, port, security?.hostPublicKey());
		},
		setSource: (current) => {
			settingsSource = current;
		},
		onChange: () => {
			const next = settingsSource();
			if (sameHostRemoteSettings(appliedLan, next)) return;
			appliedLan = next;
			lanRuntime?.replace(next).catch((error) => {
				ctx.logger.warn(`host-remote: LAN rebind failed: ${String(error)}`);
			});
		}
	});
	if (security === void 0) return;
	const artifacts = createArtifactRegistry(resolveArtifactRegistrySpec({
		listSessions: async () => (await source.list()).map((session) => ({
			sessionId: session.sessionId,
			updatedAtMs: session.updatedAt
		})),
		readHistory: async (sessionId, maxEvents) => {
			const [cut, cwd] = await Promise.all([source.history(sessionId, maxEvents), source.sessionCwd(sessionId)]);
			return {
				entries: cut.entries,
				cwd
			};
		},
		maxSessions: config.artifactScanSessions ?? 20,
		maxEventsPerSession: config.artifactScanEvents ?? 500,
		rosterCap: config.artifactRosterCap ?? 100,
		contentCharCap: config.maxToolContentChars ?? 8192
	}));
	const securityOwner = security;
	await ctx.effect(async () => {
		const attachments = ctx.get("attachments");
		const assembler = attachments === void 0 ? void 0 : await createBlobTransferAssembler(resolveBlobTransferSpec({
			stagingDir: config.blobStagingDir ?? join(resolveDshHome(void 0), "remote-blob-staging", "v1"),
			maxBlobBytes: attachments.imageLimits.maxImageBytes,
			commit: async (staged) => {
				const declared = staged.declaration.mediaType;
				if (declared === void 0 || !attachments.imageLimits.mediaTypes.includes(declared)) throw new Error(`declared media type "${declared ?? ""}" is not an accepted image type`);
				const data = await readFile(staged.path);
				const ref = await attachments.saveImage({
					data,
					mediaType: declared
				});
				return String(ref.attachmentId);
			}
		}));
		const fetchServer = createBlobFetchServer(resolveBlobFetchSpec({
			resolveAttachment: (attachmentId, sessionId) => attachments === void 0 ? Promise.resolve(void 0) : source.attachmentRef(sessionId, attachmentId),
			readAttachment: async (ref) => {
				if (attachments === void 0) throw new Error("attachment service is not composed");
				return (await attachments.readImage(ref)).data;
			},
			resolveArtifact: (artifactId, sessionId) => Promise.resolve(artifacts.resolve(artifactId, sessionId))
		}));
		const sweepTimer = setInterval(() => {
			assembler?.sweep().catch((error) => {
				ctx.logger.warn(`host-remote: blob transfer sweep failed: ${String(error)}`);
			});
			fetchServer.sweep().catch((error) => {
				ctx.logger.warn(`host-remote: blob fetch sweep failed: ${String(error)}`);
			});
		}, 6e5);
		sweepTimer.unref();
		const disposeBlobOwners = async () => {
			clearInterval(sweepTimer);
			await assembler?.dispose();
			await fetchServer.dispose();
		};
		const startSession = async (lanSettings) => {
			const lan = lanSettings.lanDiscovery === true ? resolveRemoteLanAdvertisement({
				displayName: resolvedLanDisplayName(lanSettings),
				...lanSettings.lanAddress.trim() === "" ? {} : { address: lanSettings.lanAddress.trim() },
				port,
				hostPublicKey: securityOwner.hostPublicKey()
			}) : void 0;
			const carrier = new RemoteGrpcCarrier(source, {
				...lan === void 0 ? {} : { host: lan.address },
				port,
				maxHistoryMessages: config.maxHistoryMessages ?? 200,
				maxToolContentChars: config.maxToolContentChars ?? 8192,
				resumeRetentionTtlMs: config.resumeRetentionTtlMs ?? 3e4,
				maxRetainedEvents: config.maxRetainedEvents ?? 512,
				maxRetainedJsonBytes: config.maxRetainedJsonBytes ?? 2097152,
				maxRetainedGenerations: config.maxRetainedGenerations ?? 64,
				hostInstanceId: randomUUID(),
				hostDisplayName: resolvedLanDisplayName(lanSettings),
				security: securityOwner,
				control: () => ctx.get("remoteControl"),
				commands: () => ctx.get("remoteCommands"),
				policy: () => ctx.get("remoteApprovalPolicy"),
				artifacts,
				blobs: {
					...assembler === void 0 ? {} : { assembler },
					fetch: fetchServer,
					...attachments === void 0 ? {} : { attachmentLimits: attachments.imageLimits }
				}
			});
			const boundPort = await carrier.start();
			let disposeAdvertisement;
			try {
				disposeAdvertisement = lan === void 0 ? void 0 : await advertiseRemoteLanHost({
					...lan,
					port: boundPort
				}, (renamed) => {
					ctx.logger.warn(`host-remote: LAN advertisement renamed to "${renamed}" — another responder already defends "${lan.displayName}"; choose a unique lanDisplayName`);
				});
			} catch (error) {
				await carrier.stop();
				throw error;
			}
			const discovery = lan === void 0 ? { ...REMOTE_LAN_DISCOVERY_OFF } : {
				intended: true,
				published: true,
				displayName: lan.displayName,
				address: lan.address,
				port: boundPort
			};
			pairingAdmin.setEndpoint(lan?.address ?? "127.0.0.1", boundPort);
			pairingAdmin.setDiscovery(discovery);
			return {
				carrier,
				stop: async () => {
					try {
						await disposeAdvertisement?.();
					} finally {
						await carrier.stop();
					}
				}
			};
		};
		const pairingAdmin = new RemotePairingAdministrator(securityOwner, "127.0.0.1", port, (deviceId) => {
			live?.carrier.fenceAuthorizationChanges();
			const control = ctx.get("remoteControl");
			if (control !== void 0) control.invalidateDevice(deviceId).catch((error) => {
				ctx.logger.warn(`host-remote: revoked device lease cleanup failed: ${String(error)}`);
			});
		}, async (enabled) => {
			const next = {
				...settingsSource(),
				lanDiscovery: enabled
			};
			validateHostRemoteSettings(next, port, securityOwner.hostPublicKey());
			if (lanRuntime === void 0) throw new Error("LAN discovery cannot be changed in this deployment");
			await lanRuntime.replace(next);
			appliedLan = next;
			const settings = ctx.get("settings");
			if (settings !== void 0) await settings.update(HOST_REMOTE_SETTINGS_NAMESPACE, { lanDiscovery: enabled });
			return pairingAdmin.discovery();
		});
		let live;
		let replacing = Promise.resolve();
		const replaceSession = async (next) => {
			const session = await startSession(next);
			const previous = live;
			live = session;
			appliedLan = next;
			if (previous !== void 0) await previous.stop();
		};
		lanRuntime = { replace: (next) => {
			replacing = replacing.then(() => replaceSession(next), () => replaceSession(next));
			return replacing;
		} };
		try {
			await replaceSession(settingsSource());
		} catch (error) {
			await disposeBlobOwners();
			throw error;
		}
		const disposePairingAdmin = ctx.provide("remotePairingAdmin", pairingAdmin);
		return async () => {
			lanRuntime = void 0;
			disposePairingAdmin();
			try {
				await replacing;
				await live?.stop();
			} finally {
				await disposeBlobOwners();
			}
		};
	}, "host-remote: authenticated gRPC carrier");
}
//#endregion
export { Config, HOST_REMOTE_SETTINGS_NAMESPACE, HOST_REMOTE_SETTINGS_SCHEMA, REMOTE_LAN_DISCOVERY_OFF, RemotePairingAdministrator, apply, inject, name };

//# sourceMappingURL=index.mjs.map