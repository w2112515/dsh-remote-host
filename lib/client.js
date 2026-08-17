window.__ModuleLoader__.load({
	id: "@w2112515/dsh-remote-host",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		let qrcode_lib_browser_js = require("qrcode/lib/browser.js");
		qrcode_lib_browser_js = __toESM(qrcode_lib_browser_js, 1);
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0remote-css:src/settings/client/RemoteSettingsSection.module.css.mjs
		const css = "._3mHYta_page{width:min(100%,860px);color:var(--dsw-alias-label-primary);flex-direction:column;gap:18px;display:flex}._3mHYta_hero{border:1px solid var(--dsw-alias-border-l2);background:radial-gradient(circle at 90% 10%, color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent), transparent 42%), var(--dsw-alias-bg-layer-3);border-radius:16px;justify-content:space-between;align-items:flex-start;gap:24px;padding:24px;display:flex;position:relative;overflow:hidden}._3mHYta_hero:after{border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent);content:\"\";pointer-events:none;border-radius:50%;width:180px;height:180px;position:absolute;bottom:-72px;right:-36px}._3mHYta_eyebrow{color:var(--dsw-alias-state-business-primary);letter-spacing:.14em;margin-bottom:8px;font-size:10px;font-weight:700;line-height:16px;display:block}._3mHYta_hero h2,._3mHYta_hero p,._3mHYta_panelHeading h3,._3mHYta_panelHeading p,._3mHYta_failure p,._3mHYta_actionError,._3mHYta_empty,._3mHYta_unavailable h3,._3mHYta_unavailable p{margin:0}._3mHYta_hero h2{z-index:1;letter-spacing:-.02em;text-wrap:balance;font-size:22px;font-weight:650;line-height:30px;position:relative}._3mHYta_hero p{z-index:1;max-width:590px;color:var(--dsw-alias-label-secondary);margin-top:8px;font-size:13px;line-height:21px;position:relative}._3mHYta_localBadge{z-index:1;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 82%, transparent);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;align-items:center;gap:7px;padding:5px 9px;font-size:11px;line-height:16px;display:inline-flex;position:relative}._3mHYta_localBadge>span{background:var(--dsw-alias-state-success-primary);width:7px;height:7px;box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);border-radius:50%}._3mHYta_content{flex-direction:column;gap:14px;display:flex}._3mHYta_panel{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:20px}._3mHYta_discoveryToggle{cursor:pointer;align-items:flex-start;gap:12px;margin-top:16px;display:flex}._3mHYta_discoveryToggle input{margin-top:3px}._3mHYta_discoveryToggle strong,._3mHYta_discoveryToggle small{display:block}._3mHYta_discoveryToggle small{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}._3mHYta_discoveryStatus{color:var(--dsw-alias-label-secondary);margin:12px 0 0;font-size:12px;line-height:18px}._3mHYta_discoveryStatus[data-published=true]{color:var(--dsw-alias-label-primary)}._3mHYta_panelHeading{min-width:0}._3mHYta_panelTitle{align-items:center;gap:8px;display:flex}._3mHYta_panelTitle h3,._3mHYta_unavailable h3{text-wrap:balance;font-size:14px;font-weight:650;line-height:21px}._3mHYta_panelTitle>span{background:var(--dsw-alias-bg-layer-1);min-width:20px;color:var(--dsw-alias-label-tertiary);text-align:center;font-variant-numeric:tabular-nums;border-radius:999px;padding:1px 6px;font-size:11px;line-height:18px}._3mHYta_panelHeading p,._3mHYta_unavailable p{max-width:690px;color:var(--dsw-alias-label-tertiary);margin-top:4px;font-size:12px;line-height:19px}._3mHYta_headingWithAction{justify-content:space-between;align-items:flex-start;gap:16px;display:flex}._3mHYta_pageStatus,._3mHYta_empty{color:var(--dsw-alias-label-tertiary);padding:18px 2px;font-size:13px;line-height:20px}._3mHYta_failure,._3mHYta_actionError{border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);color:var(--dsw-alias-state-error-primary);border-radius:10px;justify-content:space-between;align-items:center;gap:12px;padding:11px 13px;font-size:12px;line-height:19px;display:flex}._3mHYta_unavailable{border:1px dashed var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);border-radius:14px;align-items:flex-start;gap:13px;padding:20px;display:flex}._3mHYta_unavailableIcon{background:var(--dsw-alias-bg-layer-1);width:34px;height:34px;color:var(--dsw-alias-label-secondary);border-radius:10px;flex:none;place-items:center;display:grid}._3mHYta_invitationHint{color:var(--dsw-alias-label-secondary);margin:14px 0 0;font-size:12px;line-height:19px}._3mHYta_invitationEmpty{background:var(--dsw-alias-bg-module-platform);border-radius:12px;justify-content:space-between;align-items:center;gap:20px;margin-top:18px;padding:18px;display:flex}._3mHYta_profilePicker{border:0;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:18px 0 0;padding:0;display:grid}._3mHYta_profilePicker>legend{color:var(--dsw-alias-label-secondary);margin-bottom:8px;font-size:12px;font-weight:600;line-height:18px}._3mHYta_profileOption{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);cursor:pointer;border-radius:11px;align-items:flex-start;gap:10px;min-width:0;padding:12px;display:flex}._3mHYta_profileOption[data-selected=true]{border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 52%, var(--dsw-alias-border-l2));background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, var(--dsw-alias-bg-module-platform))}._3mHYta_profileOption>input{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary);flex:none;margin:2px 0 0}._3mHYta_profileOption>span{flex-direction:column;gap:3px;min-width:0;display:flex}._3mHYta_profileOption strong{font-size:12px;font-weight:650;line-height:18px}._3mHYta_profileOption small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}._3mHYta_phoneGlyph{border:2px solid var(--dsw-alias-border-l1);border-radius:10px;width:38px;height:54px;position:relative}._3mHYta_phoneGlyph>span{background:var(--dsw-alias-label-tertiary);border-radius:2px;width:10px;height:2px;position:absolute;top:6px;left:50%;transform:translate(-50%)}._3mHYta_phoneGlyph>i{background:var(--dsw-alias-state-business-primary);border-radius:50%;width:4px;height:4px;position:absolute;bottom:5px;left:50%;transform:translate(-50%)}._3mHYta_invitationGrid{background:var(--dsw-alias-bg-module-platform);border-radius:12px;grid-template-columns:184px minmax(0,1fr);gap:20px;margin-top:18px;padding:16px;display:grid}._3mHYta_invitationGrid[data-expired=true] ._3mHYta_qrFrame{opacity:.36;filter:grayscale()}._3mHYta_qrFrame{aspect-ratio:1;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);border-radius:10px;place-items:center;font-size:11px;line-height:17px;display:grid;overflow:hidden}._3mHYta_qrFrame img{width:100%;height:100%;display:block}._3mHYta_invitationDetails{flex-direction:column;justify-content:center;gap:14px;min-width:0;display:flex}._3mHYta_invitationStatus,._3mHYta_expired{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary);border-radius:999px;align-self:flex-start;padding:3px 8px;font-size:11px;line-height:17px}._3mHYta_expired{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);color:var(--dsw-alias-state-error-primary)}._3mHYta_detail{flex-direction:column;gap:4px;min-width:0;display:flex}._3mHYta_detail>span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}._3mHYta_detail code,._3mHYta_deviceMain code{overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;line-height:18px}._3mHYta_invitationActions,._3mHYta_pendingActions{flex-wrap:wrap;gap:8px;display:flex}._3mHYta_pendingList,._3mHYta_deviceList{flex-direction:column;gap:10px;margin:16px 0 0;padding:0;list-style:none;display:flex}._3mHYta_pendingCard{border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, var(--dsw-alias-border-l2));background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 4%, var(--dsw-alias-bg-module-platform));border-radius:12px;grid-template-columns:minmax(150px,1fr) minmax(128px,.7fr);gap:14px 20px;padding:16px;display:grid}._3mHYta_pendingIdentity{align-items:center;gap:11px;min-width:0;display:flex}._3mHYta_pendingIdentity>div{flex-direction:column;gap:2px;min-width:0;display:flex}._3mHYta_pendingIdentity strong,._3mHYta_deviceTitle strong{text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:19px;overflow:hidden}._3mHYta_pendingIdentity small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}._3mHYta_deviceAvatar{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-layer-1));width:34px;height:34px;color:var(--dsw-alias-state-business-primary);border-radius:10px;flex:none;place-items:center;font-size:13px;font-weight:650;display:grid}._3mHYta_verification{flex-direction:column;justify-content:center;align-items:flex-end;gap:2px;display:flex}._3mHYta_verification span{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}._3mHYta_verification strong{color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);letter-spacing:.12em;font-variant-numeric:tabular-nums;font-size:24px;font-weight:650;line-height:30px}._3mHYta_pendingActions{justify-content:flex-end;align-items:flex-end}._3mHYta_deviceRow{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:11px;align-items:center;gap:12px;padding:13px 14px;display:flex}._3mHYta_deviceRow[data-revoked=true]{opacity:.68}._3mHYta_deviceMain{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}._3mHYta_deviceTitle{align-items:center;gap:8px;min-width:0;display:flex}._3mHYta_deviceTitle>span{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary);border-radius:999px;flex:none;padding:1px 7px;font-size:10px;line-height:16px}._3mHYta_deviceTitle>span[data-state=revoked]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary)}._3mHYta_deviceMeta{color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;gap:4px 12px;font-size:10px;line-height:16px;display:flex}@media (width<=720px){._3mHYta_hero{flex-direction:column}._3mHYta_invitationGrid{grid-template-columns:minmax(0,1fr)}._3mHYta_qrFrame{width:min(100%,240px)}._3mHYta_pendingCard,._3mHYta_profilePicker{grid-template-columns:minmax(0,1fr)}._3mHYta_verification{align-items:flex-start}._3mHYta_pendingActions{justify-content:flex-start}._3mHYta_deviceRow{flex-wrap:wrap;align-items:flex-start}}@media (width<=480px){._3mHYta_hero,._3mHYta_panel{padding:16px}._3mHYta_invitationEmpty{flex-direction:column;align-items:flex-start}}";
		const tagId = "@w2112515/dsh-remote-host/RemoteSettingsSection.module.css";
		if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@w2112515/dsh-remote-host";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var RemoteSettingsSection_module_css_default = {
			"actionError": "_3mHYta_actionError",
			"content": "_3mHYta_content",
			"detail": "_3mHYta_detail",
			"deviceAvatar": "_3mHYta_deviceAvatar",
			"deviceList": "_3mHYta_deviceList",
			"deviceMain": "_3mHYta_deviceMain",
			"deviceMeta": "_3mHYta_deviceMeta",
			"deviceRow": "_3mHYta_deviceRow",
			"deviceTitle": "_3mHYta_deviceTitle",
			"discoveryStatus": "_3mHYta_discoveryStatus",
			"discoveryToggle": "_3mHYta_discoveryToggle",
			"empty": "_3mHYta_empty",
			"expired": "_3mHYta_expired",
			"eyebrow": "_3mHYta_eyebrow",
			"failure": "_3mHYta_failure",
			"headingWithAction": "_3mHYta_headingWithAction",
			"hero": "_3mHYta_hero",
			"invitationActions": "_3mHYta_invitationActions",
			"invitationDetails": "_3mHYta_invitationDetails",
			"invitationEmpty": "_3mHYta_invitationEmpty",
			"invitationGrid": "_3mHYta_invitationGrid",
			"invitationHint": "_3mHYta_invitationHint",
			"invitationStatus": "_3mHYta_invitationStatus",
			"localBadge": "_3mHYta_localBadge",
			"page": "_3mHYta_page",
			"pageStatus": "_3mHYta_pageStatus",
			"panel": "_3mHYta_panel",
			"panelHeading": "_3mHYta_panelHeading",
			"panelTitle": "_3mHYta_panelTitle",
			"pendingActions": "_3mHYta_pendingActions",
			"pendingCard": "_3mHYta_pendingCard",
			"pendingIdentity": "_3mHYta_pendingIdentity",
			"pendingList": "_3mHYta_pendingList",
			"phoneGlyph": "_3mHYta_phoneGlyph",
			"profileOption": "_3mHYta_profileOption",
			"profilePicker": "_3mHYta_profilePicker",
			"qrFrame": "_3mHYta_qrFrame",
			"unavailable": "_3mHYta_unavailable",
			"unavailableIcon": "_3mHYta_unavailableIcon",
			"verification": "_3mHYta_verification"
		};
		//#endregion
		//#region src/settings/client/RemoteSettingsSection.tsx
		/** Render the Host-local pairing, confirmation, and revocation surface. */
		function RemoteSettingsSection({ admin, t }) {
			const [state, setState] = (0, react.useState)({ status: "loading" });
			const [invitation, setInvitation] = (0, react.useState)();
			const [profile, setProfile] = (0, react.useState)("read-only");
			const [actionError, setActionError] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)();
			const [revoking, setRevoking] = (0, react.useState)();
			const [acknowledged, setAcknowledged] = (0, react.useState)(false);
			const pollingAvailable = state.status === "ready" && state.snapshot.available;
			const load = (0, react.useCallback)(async (quiet = false) => {
				if (!quiet) setState({ status: "loading" });
				try {
					const snapshot = await admin.snapshot();
					setState({
						status: "ready",
						snapshot
					});
				} catch {
					if (!quiet) setState({ status: "error" });
				}
			}, [admin]);
			(0, react.useEffect)(() => {
				let active = true;
				admin.snapshot().then((snapshot) => {
					if (active) setState({
						status: "ready",
						snapshot
					});
				}, () => {
					if (active) setState({ status: "error" });
				});
				return () => {
					active = false;
				};
			}, [admin]);
			(0, react.useEffect)(() => {
				if (!pollingAvailable) return;
				const timer = globalThis.setInterval(() => {
					load(true);
				}, 2e3);
				return () => {
					globalThis.clearInterval(timer);
				};
			}, [load, pollingAvailable]);
			const commit = async (key, operation) => {
				setBusy(key);
				setActionError(false);
				try {
					setState({
						status: "ready",
						snapshot: await operation()
					});
					return true;
				} catch {
					setActionError(true);
					await load(true);
					return false;
				} finally {
					setBusy(void 0);
				}
			};
			const createInvitation = async () => {
				setBusy("invitation");
				setActionError(false);
				try {
					const result = await admin.createInvitation(profile);
					setInvitation(result.invitation);
					setProfile(result.invitation.profile);
					setState({
						status: "ready",
						snapshot: result.snapshot
					});
				} catch {
					setActionError(true);
					await load(true);
				} finally {
					setBusy(void 0);
				}
			};
			const confirmRevoke = () => {
				if (revoking === void 0) return;
				const target = revoking;
				commit(`revoke:${target.deviceId}`, () => admin.revoke(target.deviceId)).then((completed) => {
					if (!completed) return;
					setRevoking(void 0);
					setAcknowledged(false);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: RemoteSettingsSection_module_css_default.page,
				"aria-busy": state.status === "loading",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: RemoteSettingsSection_module_css_default.hero,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: RemoteSettingsSection_module_css_default.eyebrow,
								children: t("eyebrow")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: t("title") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("subtitle") })
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: RemoteSettingsSection_module_css_default.localBadge,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { "aria-hidden": "true" }), t("localOnly")]
						})]
					}),
					state.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: RemoteSettingsSection_module_css_default.pageStatus,
						children: t("loading")
					}) : null,
					state.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: RemoteSettingsSection_module_css_default.failure,
						role: "alert",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("error") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							onClick: () => {
								load();
							},
							children: t("retry")
						})]
					}) : null,
					state.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [actionError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: RemoteSettingsSection_module_css_default.actionError,
						role: "alert",
						children: t("actionError")
					}) : null, !state.snapshot.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Unavailable, { t }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: RemoteSettingsSection_module_css_default.content,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiscoveryPanel, {
								discovery: state.snapshot.discovery,
								busy: busy === "discovery",
								onToggle: (enabled) => {
									commit("discovery", () => admin.setDiscovery(enabled));
								},
								t
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InvitationPanel, {
								invitation,
								profile,
								phoneReachable: state.snapshot.discovery.published,
								busy: busy === "invitation",
								onProfileChange: setProfile,
								onCreate: () => {
									createInvitation();
								},
								t
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PendingPanel, {
								pending: state.snapshot.pendingPairings,
								busy,
								onConfirm: (value) => {
									commit(`confirm:${value.invitationId}`, () => admin.confirm(value.invitationId));
								},
								onReject: (value) => {
									commit(`reject:${value.invitationId}`, () => admin.reject(value.invitationId));
								},
								t
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DevicesPanel, {
								devices: state.snapshot.devices,
								busy,
								onRevoke: (value) => {
									setRevoking(value);
									setAcknowledged(false);
								},
								onRefresh: () => {
									load(true);
								},
								t
							})
						]
					})] }) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.RiskConfirmation, {
						open: revoking !== void 0,
						title: t("revokeTitle"),
						description: t("revokeDescription"),
						acknowledgeLabel: t("revokeAcknowledge"),
						cancelLabel: t("cancel"),
						confirmLabel: t("confirmRevoke"),
						acknowledged,
						disabled: revoking !== void 0 && busy === `revoke:${revoking.deviceId}`,
						onAcknowledgedChange: setAcknowledged,
						onCancel: () => {
							setRevoking(void 0);
							setAcknowledged(false);
						},
						onConfirm: confirmRevoke
					})
				]
			});
		}
		function Unavailable({ t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: RemoteSettingsSection_module_css_default.unavailable,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: RemoteSettingsSection_module_css_default.unavailableIcon,
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLinkOutline16, {})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("unavailableTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("unavailableBody") })] })]
			});
		}
		function DiscoveryPanel({ discovery, busy, onToggle, t }) {
			const endpoint = discovery.address === void 0 ? void 0 : discovery.port === void 0 ? discovery.address : `${discovery.address}:${String(discovery.port)}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: RemoteSettingsSection_module_css_default.panel,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelHeading, {
						title: t("discoveryTitle"),
						body: t("discoveryBody")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: RemoteSettingsSection_module_css_default.discoveryToggle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: discovery.intended,
							disabled: busy,
							onChange: (event) => {
								onToggle(event.target.checked);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("discoveryEnable") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: discovery.intended ? t("discoveryOn") : t("discoveryOff") })] })]
					}),
					discovery.intended ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: RemoteSettingsSection_module_css_default.discoveryStatus,
						"data-published": discovery.published ? "true" : void 0,
						children: [
							discovery.published ? t("discoveryPublished") : t("discoveryPending"),
							discovery.displayName === void 0 ? null : ` · ${discovery.displayName}`,
							endpoint === void 0 ? null : ` · ${endpoint}`
						]
					}) : null
				]
			});
		}
		function InvitationPanel({ invitation, profile, phoneReachable, busy, onProfileChange, onCreate, t }) {
			const [now, setNow] = (0, react.useState)(Date.now());
			const [qr, setQr] = (0, react.useState)();
			const [qrFailed, setQrFailed] = (0, react.useState)(false);
			const [copied, setCopied] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (invitation === void 0) return;
				setNow(Date.now());
				const timer = globalThis.setInterval(() => {
					setNow(Date.now());
				}, 1e3);
				return () => {
					globalThis.clearInterval(timer);
				};
			}, [invitation]);
			(0, react.useEffect)(() => {
				let active = true;
				setQr(void 0);
				setQrFailed(false);
				if (invitation !== void 0) qrcode_lib_browser_js.default.toDataURL(invitation.invitationUri, {
					errorCorrectionLevel: "M",
					margin: 2,
					width: 264
				}).then((value) => {
					if (active) setQr(value);
				}, () => {
					if (active) setQrFailed(true);
				});
				return () => {
					active = false;
				};
			}, [invitation]);
			const expired = invitation !== void 0 && Number(invitation.expiresAtMs) <= now;
			const copy = () => {
				if (invitation === void 0) return;
				(0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(invitation.invitationUri).then((ok) => {
					if (!ok) return;
					setCopied(true);
					globalThis.setTimeout(() => {
						setCopied(false);
					}, 1500);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: RemoteSettingsSection_module_css_default.panel,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelHeading, {
						title: t("invitationTitle"),
						body: t("invitationBody")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						className: RemoteSettingsSection_module_css_default.profilePicker,
						disabled: busy,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: t("profileLegend") }), [
							"read-only",
							"approval-reviewer",
							"session-control",
							"session-operator",
							"session-supervisor",
							"host-supervisor"
						].map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: RemoteSettingsSection_module_css_default.profileOption,
							"data-selected": profile === value ? "true" : void 0,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "remote-pairing-profile",
								value,
								checked: profile === value,
								onChange: () => {
									onProfileChange(value);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: profileLabel(value, t) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: profileDescription(value, t) })] })]
						}, value))]
					}),
					phoneReachable ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: RemoteSettingsSection_module_css_default.invitationHint,
						role: "status",
						children: t("invitationLanRequired")
					}),
					invitation === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: RemoteSettingsSection_module_css_default.invitationEmpty,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: RemoteSettingsSection_module_css_default.phoneGlyph,
							"aria-hidden": "true",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: busy || !phoneReachable,
							onClick: onCreate,
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLinkOutline16, {}),
							children: createInvitationLabel(profile, t)
						})]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: RemoteSettingsSection_module_css_default.invitationGrid,
						"data-expired": expired ? "true" : void 0,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: RemoteSettingsSection_module_css_default.qrFrame,
							children: qrFailed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								role: "status",
								children: t("qrError")
							}) : qr === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("qrLoading") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
								src: qr,
								alt: t("qrAlt"),
								width: "264",
								height: "264"
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: RemoteSettingsSection_module_css_default.invitationDetails,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: expired ? RemoteSettingsSection_module_css_default.expired : RemoteSettingsSection_module_css_default.invitationStatus,
									children: expired ? t("expired") : `${t("expires")} ${formatTime(invitation.expiresAtMs)}`
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Detail, {
									label: t("accessProfile"),
									value: profileLabel(invitation.profile, t)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Detail, {
									label: t("hostFingerprint"),
									value: invitation.hostFingerprint,
									mono: true
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: RemoteSettingsSection_module_css_default.invitationActions,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										onClick: copy,
										icon: copied ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, {}),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											"aria-live": "polite",
											children: copied ? t("copied") : t("copyInvitation")
										})
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "ghost",
										size: "sm",
										disabled: busy,
										onClick: onCreate,
										children: t("replaceInvitation")
									})]
								})
							]
						})]
					})
				]
			});
		}
		function PendingPanel({ pending, busy, onConfirm, onReject, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: RemoteSettingsSection_module_css_default.panel,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelHeading, {
					title: t("pendingTitle"),
					body: t("pendingBody"),
					count: pending.length
				}), pending.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: RemoteSettingsSection_module_css_default.empty,
					children: t("pendingEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: RemoteSettingsSection_module_css_default.pendingList,
					children: pending.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: RemoteSettingsSection_module_css_default.pendingCard,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: RemoteSettingsSection_module_css_default.pendingIdentity,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: RemoteSettingsSection_module_css_default.deviceAvatar,
									"aria-hidden": "true",
									children: initial(value.deviceName)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: value.deviceName }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: profileLabel(value.profile, t) })] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: RemoteSettingsSection_module_css_default.verification,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("verificationCode") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
									translate: "no",
									children: value.verificationCode
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Detail, {
								label: t("deviceFingerprint"),
								value: value.deviceFingerprint,
								mono: true
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: RemoteSettingsSection_module_css_default.pendingActions,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									size: "sm",
									disabled: busy !== void 0,
									onClick: () => {
										onConfirm(value);
									},
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {}),
									children: allowProfileLabel(value.profile, t)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									disabled: busy !== void 0,
									onClick: () => {
										onReject(value);
									},
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, {}),
									children: t("rejectDevice")
								})]
							})
						]
					}, value.invitationId))
				})]
			});
		}
		function DevicesPanel({ devices, busy, onRevoke, onRefresh, t }) {
			const ordered = (0, react.useMemo)(() => [...devices].sort((left, right) => Number(left.revokedAtMs !== void 0) - Number(right.revokedAtMs !== void 0)), [devices]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: RemoteSettingsSection_module_css_default.panel,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: RemoteSettingsSection_module_css_default.headingWithAction,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelHeading, {
						title: t("devicesTitle"),
						body: t("devicesBody"),
						count: devices.length
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "toolbar",
						size: "sm",
						"aria-label": t("refresh"),
						onClick: onRefresh,
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {})
					})]
				}), ordered.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: RemoteSettingsSection_module_css_default.empty,
					children: t("devicesEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: RemoteSettingsSection_module_css_default.deviceList,
					children: ordered.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: RemoteSettingsSection_module_css_default.deviceRow,
						"data-revoked": value.revokedAtMs === void 0 ? void 0 : "true",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: RemoteSettingsSection_module_css_default.deviceAvatar,
								"aria-hidden": "true",
								children: initial(value.displayName)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: RemoteSettingsSection_module_css_default.deviceMain,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: RemoteSettingsSection_module_css_default.deviceTitle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: value.displayName }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											"data-state": value.revokedAtMs === void 0 ? "active" : "revoked",
											children: value.revokedAtMs === void 0 ? t("active") : t("revoked")
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										translate: "no",
										children: value.deviceFingerprint
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: RemoteSettingsSection_module_css_default.deviceMeta,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: profileLabel(value.profile, t) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												t("created"),
												" ",
												formatDate(value.createdAtMs)
											] }),
											value.revokedAtMs === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												t("revokedAt"),
												" ",
												formatDate(value.revokedAtMs)
											] })
										]
									})
								]
							}),
							value.revokedAtMs === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								disabled: busy !== void 0,
								onClick: () => {
									onRevoke(value);
								},
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
								children: t("revoke")
							}) : null
						]
					}, value.deviceId))
				})]
			});
		}
		function PanelHeading({ title, body, count }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: RemoteSettingsSection_module_css_default.panelHeading,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: RemoteSettingsSection_module_css_default.panelTitle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: title }), count === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: count })]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: body })]
			});
		}
		function Detail({ label, value, mono = false }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: RemoteSettingsSection_module_css_default.detail,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), mono ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
					translate: "no",
					children: value
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: value })]
			});
		}
		function formatTime(value) {
			return new Intl.DateTimeFormat(void 0, {
				hour: "2-digit",
				minute: "2-digit"
			}).format(Number(value));
		}
		function formatDate(value) {
			return new Intl.DateTimeFormat(void 0, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit"
			}).format(Number(value));
		}
		function initial(value) {
			return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? "?";
		}
		function profileLabel(profile, t) {
			switch (profile) {
				case "read-only": return t("readOnly");
				case "approval-reviewer": return t("approvalReviewer");
				case "session-control": return t("sessionControl");
				case "session-operator": return t("sessionOperator");
				case "session-supervisor": return t("sessionSupervisor");
				case "host-supervisor": return t("hostSupervisor");
			}
		}
		function profileDescription(profile, t) {
			switch (profile) {
				case "read-only": return t("readOnlyDescription");
				case "approval-reviewer": return t("approvalReviewerDescription");
				case "session-control": return t("sessionControlDescription");
				case "session-operator": return t("sessionOperatorDescription");
				case "session-supervisor": return t("sessionSupervisorDescription");
				case "host-supervisor": return t("hostSupervisorDescription");
			}
		}
		function createInvitationLabel(profile, t) {
			switch (profile) {
				case "read-only": return t("createInvitation");
				case "approval-reviewer": return t("createReviewerInvitation");
				case "session-control": return t("createControlInvitation");
				case "session-operator": return t("createOperatorInvitation");
				case "session-supervisor": return t("createSupervisorInvitation");
				case "host-supervisor": return t("createHostSupervisorInvitation");
			}
		}
		function allowProfileLabel(profile, t) {
			switch (profile) {
				case "read-only": return t("allowReadOnly");
				case "approval-reviewer": return t("allowApprovalReviewer");
				case "session-control": return t("allowSessionControl");
				case "session-operator": return t("allowSessionOperator");
				case "session-supervisor": return t("allowSessionSupervisor");
				case "host-supervisor": return t("allowHostSupervisor");
			}
		}
		//#endregion
		//#region src/settings/client/remote-api.ts
		/**
		* Bind typed administration calls to the generic Connection carrier.
		* @param rpc - trusted loopback Connection RPC client.
		* @returns strict Remote administration facade.
		*/
		function createRemoteAdminClient(rpc) {
			const call = async (endpoint, payload) => {
				const result = await rpc.call("/remote-admin", endpoint, payload);
				if (!result.ok) throw new Error(`remote administration failed: ${result.error.code}`);
				return result.value;
			};
			return {
				snapshot: async () => snapshot(await call("snapshot", {})),
				createInvitation: async (profileValue) => invitationResult(await call("invitation/create", { profile: profileValue })),
				confirm: async (invitationId) => snapshot(await call("pairing/confirm", { invitationId })),
				reject: async (invitationId) => snapshot(await call("pairing/reject", { invitationId })),
				revoke: async (deviceId) => snapshot(await call("device/revoke", { deviceId })),
				setDiscovery: async (enabled) => snapshot(await call("discovery/set", { enabled }))
			};
		}
		function snapshot(value) {
			const row = record(value);
			if (typeof row.available !== "boolean" || !Array.isArray(row.pendingPairings) || !Array.isArray(row.devices)) throw new TypeError("invalid Remote administration snapshot");
			return {
				available: row.available,
				pendingPairings: row.pendingPairings.map(pending),
				devices: row.devices.map(device),
				discovery: discovery(row.discovery)
			};
		}
		function invitationResult(value) {
			const row = record(value);
			return {
				invitation: invitation(row.invitation),
				snapshot: snapshot(row.snapshot)
			};
		}
		function invitation(value) {
			const row = record(value);
			return {
				invitationId: string(row, "invitationId"),
				invitationUri: string(row, "invitationUri"),
				hostFingerprint: string(row, "hostFingerprint"),
				expiresAtMs: decimal(row, "expiresAtMs"),
				capabilities: string(row, "capabilities"),
				profile: profile(row, "profile")
			};
		}
		function pending(value) {
			const row = record(value);
			return {
				invitationId: identifier(row, "invitationId"),
				deviceName: string(row, "deviceName"),
				deviceFingerprint: string(row, "deviceFingerprint"),
				verificationCode: string(row, "verificationCode"),
				expiresAtMs: decimal(row, "expiresAtMs"),
				capabilities: string(row, "capabilities"),
				profile: profile(row, "profile")
			};
		}
		function device(value) {
			const row = record(value);
			const revokedAtMs = row.revokedAtMs === void 0 ? void 0 : decimal(row, "revokedAtMs");
			return {
				deviceId: identifier(row, "deviceId"),
				displayName: string(row, "displayName"),
				deviceFingerprint: string(row, "deviceFingerprint"),
				capabilities: string(row, "capabilities"),
				createdAtMs: decimal(row, "createdAtMs"),
				...revokedAtMs === void 0 ? {} : { revokedAtMs },
				authorityEpoch: decimal(row, "authorityEpoch"),
				profile: profile(row, "profile")
			};
		}
		function discovery(value) {
			const row = record(value);
			if (typeof row.intended !== "boolean" || typeof row.published !== "boolean") throw new TypeError("invalid Remote LAN discovery view");
			return {
				intended: row.intended,
				published: row.published,
				...typeof row.displayName === "string" ? { displayName: row.displayName } : {},
				...typeof row.address === "string" ? { address: row.address } : {},
				...typeof row.port === "number" ? { port: row.port } : {}
			};
		}
		function record(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected object");
			return value;
		}
		function string(row, key) {
			if (typeof row[key] !== "string") throw new TypeError(`expected string field ${key}`);
			return row[key];
		}
		function decimal(row, key) {
			const value = string(row, key);
			if (!/^\d+$/u.test(value)) throw new TypeError(`expected decimal field ${key}`);
			return value;
		}
		function identifier(row, key) {
			const value = string(row, key);
			if (!/^[0-9a-f]{32}$/iu.test(value)) throw new TypeError(`expected identifier field ${key}`);
			return value;
		}
		function profile(row, key) {
			const value = string(row, key);
			if (value !== "read-only" && value !== "approval-reviewer" && value !== "session-control" && value !== "session-operator" && value !== "session-supervisor" && value !== "host-supervisor") throw new TypeError(`expected Remote pairing profile field ${key}`);
			return value;
		}
		//#endregion
		//#region src/settings/client/locales.ts
		/** Product copy for Host-local DSH Remote administration. */
		const zh = {
			nav: "手机访问",
			eyebrow: "DSH REMOTE",
			title: "从手机安全查看 DSH",
			subtitle: "配对和访问权限都由这台电脑确认。手机无法自行提升权限。",
			localOnly: "仅限本机管理",
			loading: "正在读取远程访问状态…",
			error: "暂时无法读取远程访问状态。",
			retry: "重试",
			unavailableTitle: "DSH Remote 尚未启用",
			unavailableBody: "启用 Host Remote 插件并配置安全存储后，才能创建手机配对邀请。",
			invitationTitle: "连接新手机",
			invitationBody: "先选择这台手机可获得的权限，再创建一个 5 分钟有效、仅可使用一次的邀请。扫码后仍需在这里核对并确认。",
			profileLegend: "这台手机可以做什么",
			readOnlyDescription: "查看会话和工具结果，不能发送指令。",
			approvalReviewer: "审批审核员",
			approvalReviewerDescription: "查看会话，并处理 Host 明确发布的单次审批；不能发送或停止任务。",
			sessionControl: "会话控制",
			sessionControlDescription: "查看会话，并在取得单会话控制权后发送指令；不包含停止或审批权限。",
			sessionOperator: "会话操作员",
			sessionOperatorDescription: "查看会话、发送指令并停止当前活动；仍不包含审批权限。",
			sessionSupervisor: "会话主管",
			sessionSupervisorDescription: "查看、发送、停止，并处理单次审批。这是最高的会话权限，请只授予你控制的手机。",
			hostSupervisor: "主机守护",
			hostSupervisorDescription: "会话主管的全部权限，并可启动、停止或重启这台电脑上的 dsh 服务。请只授予你完全信任的手机。",
			invitationLanRequired: "当前邀请只指向这台电脑自己，手机扫码会连不上。请先打开「允许附近的手机发现这台电脑」，等显示已发布后再创建配对码。",
			createInvitation: "创建配对码",
			createReviewerInvitation: "创建审批审核员配对码",
			createControlInvitation: "创建会话控制配对码",
			createOperatorInvitation: "创建会话操作员配对码",
			createSupervisorInvitation: "创建会话主管配对码",
			createHostSupervisorInvitation: "创建主机守护配对码",
			replaceInvitation: "换一个配对码",
			qrAlt: "DSH Remote 手机配对二维码",
			qrLoading: "正在生成二维码…",
			qrError: "二维码生成失败，请复制配对链接。",
			expires: "有效期至",
			expired: "此配对码已过期",
			hostFingerprint: "Host 指纹",
			accessProfile: "访问权限",
			copyInvitation: "复制配对链接",
			copied: "已复制",
			pendingTitle: "等待你的确认",
			pendingBody: "只允许你正在操作、且验证码与手机一致的设备。",
			pendingEmpty: "暂无等待确认的手机。",
			verificationCode: "核对码",
			deviceFingerprint: "设备指纹",
			allowReadOnly: "允许只读访问",
			allowApprovalReviewer: "允许审批审核员访问",
			allowSessionControl: "允许会话控制",
			allowSessionOperator: "允许会话操作员访问",
			allowSessionSupervisor: "允许会话主管访问",
			allowHostSupervisor: "允许主机守护访问",
			rejectDevice: "拒绝此设备",
			devicesTitle: "已配对设备",
			devicesBody: "撤销后，该设备必须重新完成一次明确配对才能再次连接。",
			devicesEmpty: "还没有已配对设备。",
			active: "可访问",
			revoked: "已撤销",
			readOnly: "只读会话",
			created: "配对时间",
			revokedAt: "撤销时间",
			revoke: "撤销访问",
			revokeTitle: "撤销此手机的访问？",
			revokeDescription: "设备将无法重新连接或读取新的 DSH 会话。已经显示在手机上的内容不会被远程删除。",
			revokeAcknowledge: "我确认要撤销此设备，之后重新使用需要再次配对。",
			cancel: "取消",
			confirmRevoke: "撤销设备访问",
			actionError: "操作未完成。状态已重新读取，请检查后再试。",
			refresh: "刷新",
			discoveryTitle: "附近设备",
			discoveryBody: "打开后，同一 Wi-Fi 上的手机可以搜到这台电脑。搜到之后仍要在这里扫码并确认，点到一台主机不会自动授权。",
			discoveryEnable: "允许附近的手机发现这台电脑",
			discoveryOn: "附近的手机关可以看到这台电脑",
			discoveryOff: "仅本机可连接，附近搜索看不到这台电脑",
			discoveryPublished: "已在当前 Wi-Fi 发布",
			discoveryPending: "已打开，正在发布到当前 Wi-Fi…",
			discoveryAddress: "地址"
		};
		/** English Remote settings product copy, complete against the Chinese authority. */
		const en = {
			nav: "Mobile access",
			eyebrow: "DSH REMOTE",
			title: "View DSH securely from your phone",
			subtitle: "Pairing and access are confirmed on this computer. A phone cannot elevate its own permissions.",
			localOnly: "Managed on this Host only",
			loading: "Reading remote access status…",
			error: "Remote access status is temporarily unavailable.",
			retry: "Retry",
			unavailableTitle: "DSH Remote is not enabled",
			unavailableBody: "Enable the Host Remote plugin and configure its security store before creating a mobile invitation.",
			invitationTitle: "Connect a new phone",
			invitationBody: "Choose what this phone may do, then create a single-use invitation valid for five minutes. Scanning still requires verification and confirmation here.",
			profileLegend: "What this phone can do",
			readOnlyDescription: "View sessions and tool results without sending instructions.",
			approvalReviewer: "Approval reviewer",
			approvalReviewerDescription: "View sessions and decide explicit one-time Host approvals. Cannot send or stop work.",
			sessionControl: "Session control",
			sessionControlDescription: "View sessions and send instructions after acquiring control of one session. Stop and approval are not included.",
			sessionOperator: "Session operator",
			sessionOperatorDescription: "View sessions, send instructions, and stop the current activity. Approval is not included.",
			sessionSupervisor: "Session supervisor",
			sessionSupervisorDescription: "View, send, stop, and decide one-time approvals. This is the highest session profile; grant it only to a phone you control.",
			hostSupervisor: "Host supervisor",
			hostSupervisorDescription: "Everything a session supervisor can do, plus starting, stopping, and restarting the dsh service on this computer. Grant it only to a phone you fully trust.",
			invitationLanRequired: "This invitation would only point at this computer. A phone cannot connect until nearby discovery is on and published. Turn that on, then create a pairing code.",
			createInvitation: "Create pairing code",
			createReviewerInvitation: "Create reviewer pairing code",
			createControlInvitation: "Create control pairing code",
			createOperatorInvitation: "Create operator pairing code",
			createSupervisorInvitation: "Create supervisor pairing code",
			createHostSupervisorInvitation: "Create host supervisor pairing code",
			replaceInvitation: "Replace pairing code",
			qrAlt: "DSH Remote mobile pairing QR code",
			qrLoading: "Generating QR code…",
			qrError: "The QR code could not be generated. Copy the pairing link instead.",
			expires: "Valid until",
			expired: "This pairing code has expired",
			hostFingerprint: "Host fingerprint",
			accessProfile: "Access",
			copyInvitation: "Copy pairing link",
			copied: "Copied",
			pendingTitle: "Waiting for your confirmation",
			pendingBody: "Allow only the device you are operating and whose code matches the phone.",
			pendingEmpty: "No phones are waiting for confirmation.",
			verificationCode: "Verification code",
			deviceFingerprint: "Device fingerprint",
			allowReadOnly: "Allow read-only access",
			allowApprovalReviewer: "Allow approval reviewer access",
			allowSessionControl: "Allow session control",
			allowSessionOperator: "Allow session operator access",
			allowSessionSupervisor: "Allow session supervisor access",
			allowHostSupervisor: "Allow host supervisor access",
			rejectDevice: "Reject this device",
			devicesTitle: "Paired devices",
			devicesBody: "After revocation, this device must complete explicit pairing again before it can reconnect.",
			devicesEmpty: "No devices have been paired yet.",
			active: "Can access",
			revoked: "Revoked",
			readOnly: "Read-only sessions",
			created: "Paired",
			revokedAt: "Revoked",
			revoke: "Revoke access",
			revokeTitle: "Revoke access for this phone?",
			revokeDescription: "The device will no longer reconnect or read new DSH sessions. Content already displayed on the phone cannot be remotely erased.",
			revokeAcknowledge: "I understand this device must pair again before it can be used.",
			cancel: "Cancel",
			confirmRevoke: "Revoke device access",
			actionError: "The action did not complete. Status was reloaded; review it and try again.",
			refresh: "Refresh",
			discoveryTitle: "Nearby devices",
			discoveryBody: "When this is on, phones on the same Wi-Fi can find this computer. Finding it still requires a pairing code and confirmation here; selecting a host never grants access.",
			discoveryEnable: "Allow nearby phones to find this computer",
			discoveryOn: "Nearby phones can see this computer",
			discoveryOff: "Only this computer can connect; nearby search will not list it",
			discoveryPublished: "Published on this Wi-Fi",
			discoveryPending: "Turned on; publishing on this Wi-Fi…",
			discoveryAddress: "Address"
		};
		//#endregion
		//#region src/settings/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.remote";
		/** Services required by the Settings registration and local Connection face. */
		const inject = [
			"slots",
			"locale",
			"connection"
		];
		/** Register the page only when this browser itself is running on the Host. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-settings-remote: dictionaries");
			const connection = ctx.get("connection");
			if (!connection.isLoopback) return;
			const t = ctx.locale.bind(NS);
			const admin = createRemoteAdminClient(connection.rpc);
			const injected = () => ({ admin });
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "remote",
				order: 30,
				label: () => t("nav"),
				locale: NS,
				inject: injected
			}, RemoteSettingsSection));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map