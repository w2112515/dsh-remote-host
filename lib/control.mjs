import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
//#region src/control/spec.ts
/** Durable schemas for Remote command idempotency and control fencing. */
const UINT64_MAX$1 = 18446744073709551615n;
const asciiIdentifier = z$1.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);
const hex16 = z$1.string().length(32).regex(/^[0-9a-f]+$/);
const hex32 = z$1.string().length(64).regex(/^[0-9a-f]+$/);
const decimalUint64 = z$1.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => BigInt(value) <= UINT64_MAX$1);
const safeTimestamp = z$1.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Runtime command-id schema. */
const remoteCommandIdSchema = asciiIdentifier.transform((value) => value);
/** Runtime stable-device schema. */
const remoteDeviceIdSchema = hex16.transform((value) => value);
/** Runtime control-epoch schema. */
const remoteControlEpochSchema = decimalUint64.transform((value) => value);
const bindingFields = {
	commandId: remoteCommandIdSchema,
	operation: z$1.enum([
		"send_input",
		"stop",
		"decide_approval",
		"create_session",
		"select_agent_preset",
		"select_model",
		"fork_session",
		"revoke_approval_rule",
		"set_session_budget"
	]),
	sessionId: z$1.string().min(1).max(256).transform((value) => value),
	requestFingerprint: hex32,
	deviceId: remoteDeviceIdSchema,
	authorityEpoch: decimalUint64,
	controlEpoch: remoteControlEpochSchema.optional(),
	targetTurn: safeTimestamp.optional(),
	approvalId: asciiIdentifier.optional(),
	approvalRevision: asciiIdentifier.optional(),
	approvalOutcome: z$1.enum(["allowed-once", "rejected"]).optional(),
	agentPreset: asciiIdentifier.optional(),
	modelSelection: z$1.object({
		provider: asciiIdentifier.max(100),
		model: z$1.string().min(1).max(200).regex(/^[\x21-\x7e]+$/),
		reasoningEffort: asciiIdentifier.max(100).optional()
	}).optional(),
	childSessionId: z$1.string().min(1).max(256).transform((value) => value).optional(),
	forkAtSeq: safeTimestamp.optional(),
	ruleId: asciiIdentifier.optional(),
	maxTotalTokens: z$1.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
};
const baseFields = {
	...bindingFields,
	correlation: z$1.uuid().transform((value) => value),
	createdAtMs: safeTimestamp,
	updatedAtMs: safeTimestamp
};
/** Runtime Session correlation schema. */
const remoteCommandCommitSchema = z$1.union([
	z$1.object({
		sessionEventSeq: safeTimestamp,
		messageId: z$1.string().min(1).max(256)
	}),
	z$1.object({
		targetTurn: safeTimestamp,
		turnEndSeq: safeTimestamp
	}),
	z$1.object({
		approvalId: asciiIdentifier,
		outcome: z$1.enum(["allowed-once", "rejected"]),
		decidedEventSeq: safeTimestamp
	}),
	z$1.object({
		created: z$1.literal(true),
		agentPreset: asciiIdentifier.optional()
	}),
	z$1.object({ selectedPreset: asciiIdentifier }),
	z$1.object({ selectedModel: z$1.object({
		provider: asciiIdentifier.max(100),
		model: z$1.string().min(1).max(200).regex(/^[\x21-\x7e]+$/),
		reasoningEffort: asciiIdentifier.max(100).optional()
	}) }),
	z$1.object({
		forked: z$1.literal(true),
		childSessionId: z$1.string().min(1).max(256).transform((value) => value)
	}),
	z$1.object({ revokedRuleId: asciiIdentifier }),
	z$1.object({
		budgetSet: z$1.literal(true),
		maxTotalTokens: z$1.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
	})
]);
/** Runtime definitive-rejection schema. */
const remoteCommandRejectionSchema = z$1.object({ code: asciiIdentifier });
/** Runtime schema for one journal row. */
const remoteCommandRowSchema = z$1.discriminatedUnion("phase", [
	z$1.object({
		...baseFields,
		phase: z$1.literal("reserved"),
		revision: z$1.literal(0)
	}),
	z$1.object({
		...baseFields,
		phase: z$1.literal("requested"),
		revision: z$1.literal(1),
		requested: z$1.object({ targetTurn: safeTimestamp })
	}),
	z$1.object({
		...baseFields,
		phase: z$1.literal("committed"),
		revision: z$1.union([z$1.literal(1), z$1.literal(2)]),
		commit: remoteCommandCommitSchema
	}),
	z$1.object({
		...baseFields,
		phase: z$1.literal("rejected"),
		revision: z$1.literal(1),
		rejection: remoteCommandRejectionSchema
	})
]).superRefine((row, ctx) => {
	if (row.updatedAtMs < row.createdAtMs) ctx.addIssue({
		code: "custom",
		path: ["updatedAtMs"],
		message: "updatedAtMs must not precede createdAtMs"
	});
	if (row.operation === "stop" !== (row.targetTurn !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["targetTurn"],
		message: "targetTurn must exist only for stop"
	});
	if ((row.operation === "send_input" || row.operation === "stop" || row.operation === "select_model") !== (row.controlEpoch !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["controlEpoch"],
		message: "controlEpoch must exist only for controlled operations"
	});
	if (row.operation === "decide_approval" !== (row.approvalId !== void 0 && row.approvalRevision !== void 0 && row.approvalOutcome !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["approvalId"],
		message: "approval binding fields must exist only for decide_approval"
	});
	if (!(row.operation === "create_session" || row.operation === "select_agent_preset") && row.agentPreset !== void 0) ctx.addIssue({
		code: "custom",
		path: ["agentPreset"],
		message: "agentPreset must exist only for preset operations"
	});
	if (row.operation === "select_agent_preset" && row.agentPreset === void 0) ctx.addIssue({
		code: "custom",
		path: ["agentPreset"],
		message: "select_agent_preset binding must name a preset"
	});
	if (row.operation === "select_model" !== (row.modelSelection !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["modelSelection"],
		message: "modelSelection must exist only for select_model"
	});
	const forkOperation = row.operation === "fork_session";
	if (forkOperation !== (row.childSessionId !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["childSessionId"],
		message: "childSessionId must exist only for fork_session"
	});
	if (!forkOperation && row.forkAtSeq !== void 0) ctx.addIssue({
		code: "custom",
		path: ["forkAtSeq"],
		message: "forkAtSeq must exist only for fork_session"
	});
	if (row.operation === "revoke_approval_rule" !== (row.ruleId !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["ruleId"],
		message: "ruleId must exist only for revoke_approval_rule"
	});
	if (row.operation === "set_session_budget" !== (row.maxTotalTokens !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["maxTotalTokens"],
		message: "maxTotalTokens must exist only for set_session_budget"
	});
	if (row.phase === "requested") {
		if (row.operation !== "stop" || row.targetTurn !== row.requested.targetTurn) ctx.addIssue({
			code: "custom",
			path: ["requested"],
			message: "requested turn must match stop binding"
		});
	}
	if (row.phase === "committed") {
		const stopCommit = "turnEndSeq" in row.commit;
		const approvalCommit = "decidedEventSeq" in row.commit;
		const createCommit = "created" in row.commit;
		const selectCommit = "selectedPreset" in row.commit;
		const modelCommit = "selectedModel" in row.commit;
		const forkCommit = "forked" in row.commit;
		const revokeCommit = "revokedRuleId" in row.commit;
		const budgetCommit = "budgetSet" in row.commit;
		if (row.operation === "stop") {
			if (!stopCommit || approvalCommit || row.revision !== 2 || row.targetTurn !== ("targetTurn" in row.commit ? row.commit.targetTurn : void 0)) ctx.addIssue({
				code: "custom",
				path: ["commit"],
				message: "stop commit must match target turn at revision 2"
			});
		} else if (row.operation === "decide_approval") {
			if (!approvalCommit || stopCommit || row.revision !== 1 || row.approvalId !== ("approvalId" in row.commit ? row.commit.approvalId : void 0) || row.approvalOutcome !== ("outcome" in row.commit ? row.commit.outcome : void 0)) ctx.addIssue({
				code: "custom",
				path: ["commit"],
				message: "approval commit must match the exact decision at revision 1"
			});
		} else if (row.operation === "create_session") {
			if (!createCommit || row.revision !== 1 || row.agentPreset !== void 0 && "agentPreset" in row.commit && row.commit.agentPreset !== void 0 && row.commit.agentPreset !== row.agentPreset) ctx.addIssue({
				code: "custom",
				path: ["commit"],
				message: "create commit must record creation at revision 1 and match any bound preset"
			});
		} else if (row.operation === "select_agent_preset") {
			if (!selectCommit || row.revision !== 1 || "selectedPreset" in row.commit && row.commit.selectedPreset !== row.agentPreset) ctx.addIssue({
				code: "custom",
				path: ["commit"],
				message: "select commit must record the exact bound preset at revision 1"
			});
		} else if (row.operation === "select_model") {
			if (!modelCommit || row.revision !== 1 || "selectedModel" in row.commit && row.modelSelection !== void 0 && (row.commit.selectedModel.provider !== row.modelSelection.provider || row.commit.selectedModel.model !== row.modelSelection.model || row.commit.selectedModel.reasoningEffort !== row.modelSelection.reasoningEffort)) ctx.addIssue({
				code: "custom",
				path: ["commit"],
				message: "select_model commit must record the exact bound triple at revision 1"
			});
		} else if (row.operation === "fork_session") {
			if (!forkCommit || row.revision !== 1 || "childSessionId" in row.commit && row.commit.childSessionId !== row.childSessionId) ctx.addIssue({
				code: "custom",
				path: ["commit"],
				message: "fork commit must record the bound child session at revision 1"
			});
		} else if (row.operation === "revoke_approval_rule") {
			if (!revokeCommit || row.revision !== 1 || "revokedRuleId" in row.commit && row.commit.revokedRuleId !== row.ruleId) ctx.addIssue({
				code: "custom",
				path: ["commit"],
				message: "revoke commit must record the exact bound rule at revision 1"
			});
		} else if (row.operation === "set_session_budget") {
			if (!budgetCommit || row.revision !== 1 || "maxTotalTokens" in row.commit && row.commit.maxTotalTokens !== row.maxTotalTokens) ctx.addIssue({
				code: "custom",
				path: ["commit"],
				message: "budget commit must record the exact bound ceiling at revision 1"
			});
		} else if (stopCommit || approvalCommit || createCommit || selectCommit || modelCommit || forkCommit || revokeCommit || budgetCommit || row.revision !== 1) ctx.addIssue({
			code: "custom",
			path: ["commit"],
			message: "send commit must carry Inbox correlation at revision 1"
		});
	}
});
/** Runtime schema for the semantic reservation binding. */
const remoteCommandBindingSchema = z$1.object(bindingFields).superRefine((binding, ctx) => {
	if (binding.operation === "stop" !== (binding.targetTurn !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["targetTurn"],
		message: "targetTurn must exist only for stop"
	});
	if ((binding.operation === "send_input" || binding.operation === "stop" || binding.operation === "select_model") !== (binding.controlEpoch !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["controlEpoch"],
		message: "controlEpoch must exist only for controlled operations"
	});
	if (binding.operation === "decide_approval" !== (binding.approvalId !== void 0 && binding.approvalRevision !== void 0 && binding.approvalOutcome !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["approvalId"],
		message: "approval binding fields must exist only for decide_approval"
	});
	if (!(binding.operation === "create_session" || binding.operation === "select_agent_preset") && binding.agentPreset !== void 0) ctx.addIssue({
		code: "custom",
		path: ["agentPreset"],
		message: "agentPreset must exist only for preset operations"
	});
	if (binding.operation === "select_agent_preset" && binding.agentPreset === void 0) ctx.addIssue({
		code: "custom",
		path: ["agentPreset"],
		message: "select_agent_preset binding must name a preset"
	});
	if (binding.operation === "select_model" !== (binding.modelSelection !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["modelSelection"],
		message: "modelSelection must exist only for select_model"
	});
	const forkOperation = binding.operation === "fork_session";
	if (forkOperation !== (binding.childSessionId !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["childSessionId"],
		message: "childSessionId must exist only for fork_session"
	});
	if (!forkOperation && binding.forkAtSeq !== void 0) ctx.addIssue({
		code: "custom",
		path: ["forkAtSeq"],
		message: "forkAtSeq must exist only for fork_session"
	});
	if (binding.operation === "revoke_approval_rule" !== (binding.ruleId !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["ruleId"],
		message: "ruleId must exist only for revoke_approval_rule"
	});
	if (binding.operation === "set_session_budget" !== (binding.maxTotalTokens !== void 0)) ctx.addIssue({
		code: "custom",
		path: ["maxTotalTokens"],
		message: "maxTotalTokens must exist only for set_session_budget"
	});
});
/** Durable command format; a mismatch fails effect admission closed. */
const remoteCommandJournalSpec = defineDomain({
	name: "remote_command_journal",
	version: 0,
	tables: { commands: domainTable(remoteCommandRowSchema) }
});
/** Durable per-Session epoch tombstone. Active holders and secrets stay in memory. */
const remoteControlFenceRowSchema = z$1.object({
	sessionId: z$1.string().min(1).max(256).transform((value) => value),
	lastEpoch: remoteControlEpochSchema
});
/** Durable control-fence format; rows are never deleted or reset. */
const remoteControlFenceSpec = defineDomain({
	name: "remote_control_fences",
	version: 0,
	tables: { sessions: domainTable(remoteControlFenceRowSchema) }
});
//#endregion
//#region src/control/journal.ts
/** Host-global durable command journal implementation. */
/**
* Hash an explicit canonical command tuple; arbitrary object serialization is
* deliberately excluded from this identity boundary.
* @param input - semantic command fields whose equality permits replay.
* @returns lower-case SHA-256 hex.
*/
function fingerprintRemoteSendInput(input) {
	const fields = [
		"remote-command-v1",
		"send_input",
		input.sessionId,
		input.text,
		input.deviceId,
		input.authorityEpoch,
		input.controlEpoch,
		...input.attachmentIds ?? []
	];
	const hash = createHash("sha256");
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		hash.update(String(bytes.byteLength)).update(":").update(bytes).update(";");
	}
	return hash.digest("hex");
}
/**
* Hash the exact Stop target and authenticated fences.
* @param input - semantic Stop fields whose equality permits replay.
* @returns lower-case SHA-256 hex.
*/
function fingerprintRemoteStop(input) {
	const fields = [
		"remote-command-v1",
		"stop",
		input.sessionId,
		String(input.targetTurn),
		input.deviceId,
		input.authorityEpoch,
		input.controlEpoch
	];
	const hash = createHash("sha256");
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		hash.update(String(bytes.byteLength)).update(":").update(bytes).update(";");
	}
	return hash.digest("hex");
}
/**
* Hash one exact pending approval revision and authenticated decision-maker.
* @param input - Exact approval identity, outcome and authenticated authority binding.
* @returns Canonical SHA-256 request fingerprint.
*/
function fingerprintRemoteApprovalDecision(input) {
	const fields = [
		"remote-command-v1",
		"decide_approval",
		input.sessionId,
		input.approvalId,
		input.approvalRevision,
		input.outcome,
		input.deviceId,
		input.authorityEpoch,
		...input.grantSameKind === true ? ["grant-same-kind"] : []
	];
	const hash = createHash("sha256");
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		hash.update(String(bytes.byteLength)).update(":").update(bytes).update(";");
	}
	return hash.digest("hex");
}
/**
* Hash one caller-preallocated Session creation (S-mode-select). Creation is
* naturally idempotent at the owner (same id returns the same session); the
* fingerprint still pins the authenticated semantics so a reused command_id
* with different intent conflicts instead of silently replaying.
* @param input - semantic create fields whose equality permits replay.
* @returns lower-case SHA-256 hex.
*/
function fingerprintRemoteCreateSession(input) {
	const fields = [
		"remote-command-v1",
		"create_session",
		input.sessionId,
		input.agentPreset ?? "",
		input.workspaceId ?? "",
		input.newWorkspaceName ?? "",
		input.deviceId,
		input.authorityEpoch
	];
	const hash = createHash("sha256");
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		hash.update(String(bytes.byteLength)).update(":").update(bytes).update(";");
	}
	return hash.digest("hex");
}
/**
* Hash one exact blank-session preset selection (S-mode-select).
* @param input - semantic select fields whose equality permits replay.
* @returns lower-case SHA-256 hex.
*/
function fingerprintRemoteSelectAgentPreset(input) {
	const fields = [
		"remote-command-v1",
		"select_agent_preset",
		input.sessionId,
		input.agentPreset,
		input.deviceId,
		input.authorityEpoch
	];
	const hash = createHash("sha256");
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		hash.update(String(bytes.byteLength)).update(":").update(bytes).update(";");
	}
	return hash.digest("hex");
}
/**
* Hash one exact model selection (S-session-admin). The selection is
* set-valued at the owner (re-selecting the same triple converges), and the
* presented control epoch pins the fence it was admitted under.
* @param input - semantic select fields whose equality permits replay.
* @returns lower-case SHA-256 hex.
*/
function fingerprintRemoteSelectModel(input) {
	const fields = [
		"remote-command-v1",
		"select_model",
		input.sessionId,
		input.provider,
		input.model,
		input.reasoningEffort ?? "",
		input.deviceId,
		input.authorityEpoch,
		input.controlEpoch
	];
	const hash = createHash("sha256");
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		hash.update(String(bytes.byteLength)).update(":").update(bytes).update(";");
	}
	return hash.digest("hex");
}
/**
* Hash one caller-preallocated Session fork (S-session-admin). The owner
* converges a retry to the same child, so the fingerprint pins exactly the
* source, child id, anchor, and authenticated authority.
* @param input - semantic fork fields whose equality permits replay.
* @returns lower-case SHA-256 hex.
*/
function fingerprintRemoteForkSession(input) {
	const fields = [
		"remote-command-v1",
		"fork_session",
		input.sessionId,
		input.childSessionId,
		input.atSeq === void 0 ? "" : String(input.atSeq),
		input.deviceId,
		input.authorityEpoch
	];
	const hash = createHash("sha256");
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		hash.update(String(bytes.byteLength)).update(":").update(bytes).update(";");
	}
	return hash.digest("hex");
}
/**
* Hash one exact rule revocation (S-policy). Revocation is set-valued at the
* owner (the rule is gone either way), so the fingerprint pins the exact rule
* and authenticated authority.
* @param input - semantic revoke fields whose equality permits replay.
* @returns lower-case SHA-256 hex.
*/
function fingerprintRemoteRevokeApprovalRule(input) {
	const fields = [
		"remote-command-v1",
		"revoke_approval_rule",
		input.sessionId,
		input.ruleId,
		input.deviceId,
		input.authorityEpoch
	];
	const hash = createHash("sha256");
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		hash.update(String(bytes.byteLength)).update(":").update(bytes).update(";");
	}
	return hash.digest("hex");
}
/**
* Hash one exact session budget ceiling (S-policy). The budget fold is
* last-wins at the owner, so re-setting the same ceiling converges.
* @param input - semantic budget fields whose equality permits replay.
* @returns lower-case SHA-256 hex.
*/
function fingerprintRemoteSetSessionBudget(input) {
	const fields = [
		"remote-command-v1",
		"set_session_budget",
		input.sessionId,
		String(input.maxTotalTokens),
		input.deviceId,
		input.authorityEpoch
	];
	const hash = createHash("sha256");
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		hash.update(String(bytes.byteLength)).update(":").update(bytes).update(";");
	}
	return hash.digest("hex");
}
function sameBinding(row, binding) {
	return row.commandId === binding.commandId && row.operation === binding.operation && row.sessionId === binding.sessionId && row.requestFingerprint === binding.requestFingerprint && row.deviceId === binding.deviceId && row.authorityEpoch === binding.authorityEpoch && row.controlEpoch === binding.controlEpoch && row.targetTurn === binding.targetTurn && row.approvalId === binding.approvalId && row.approvalRevision === binding.approvalRevision && row.approvalOutcome === binding.approvalOutcome && row.agentPreset === binding.agentPreset && row.forkAtSeq === binding.forkAtSeq && row.childSessionId === binding.childSessionId && row.ruleId === binding.ruleId && row.maxTotalTokens === binding.maxTotalTokens && sameModelSelection(row.modelSelection, binding.modelSelection);
}
function sameModelSelection(left, right) {
	if (left === void 0 || right === void 0) return left === right;
	return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
function sameCommit(left, right) {
	if ("turnEndSeq" in left) return "turnEndSeq" in right && left.targetTurn === right.targetTurn && left.turnEndSeq === right.turnEndSeq;
	if ("decidedEventSeq" in left) return "decidedEventSeq" in right && left.approvalId === right.approvalId && left.outcome === right.outcome && left.decidedEventSeq === right.decidedEventSeq;
	if ("created" in left) return "created" in right && left.agentPreset === right.agentPreset;
	if ("selectedPreset" in left) return "selectedPreset" in right && left.selectedPreset === right.selectedPreset;
	if ("selectedModel" in left) return "selectedModel" in right && left.selectedModel.provider === right.selectedModel.provider && left.selectedModel.model === right.selectedModel.model && left.selectedModel.reasoningEffort === right.selectedModel.reasoningEffort;
	if ("forked" in left) return "forked" in right && left.childSessionId === right.childSessionId;
	if ("revokedRuleId" in left) return "revokedRuleId" in right && left.revokedRuleId === right.revokedRuleId;
	if ("budgetSet" in left) return "budgetSet" in right && left.maxTotalTokens === right.maxTotalTokens;
	return !("turnEndSeq" in right) && !("decidedEventSeq" in right) && !("created" in right) && !("selectedPreset" in right) && !("selectedModel" in right) && !("forked" in right) && !("revokedRuleId" in right) && !("budgetSet" in right) && left.sessionEventSeq === right.sessionEventSeq && left.messageId === right.messageId;
}
function snapshotRow(row) {
	const base = {
		commandId: row.commandId,
		operation: row.operation,
		sessionId: row.sessionId,
		requestFingerprint: row.requestFingerprint,
		deviceId: row.deviceId,
		authorityEpoch: row.authorityEpoch,
		...row.controlEpoch === void 0 ? {} : { controlEpoch: row.controlEpoch },
		...row.targetTurn === void 0 ? {} : { targetTurn: row.targetTurn },
		...row.approvalId === void 0 ? {} : { approvalId: row.approvalId },
		...row.approvalRevision === void 0 ? {} : { approvalRevision: row.approvalRevision },
		...row.approvalOutcome === void 0 ? {} : { approvalOutcome: row.approvalOutcome },
		...row.agentPreset === void 0 ? {} : { agentPreset: row.agentPreset },
		...row.modelSelection === void 0 ? {} : { modelSelection: Object.freeze({
			provider: row.modelSelection.provider,
			model: row.modelSelection.model,
			...row.modelSelection.reasoningEffort === void 0 ? {} : { reasoningEffort: row.modelSelection.reasoningEffort }
		}) },
		...row.childSessionId === void 0 ? {} : { childSessionId: row.childSessionId },
		...row.forkAtSeq === void 0 ? {} : { forkAtSeq: row.forkAtSeq },
		...row.ruleId === void 0 ? {} : { ruleId: row.ruleId },
		...row.maxTotalTokens === void 0 ? {} : { maxTotalTokens: row.maxTotalTokens },
		correlation: row.correlation,
		createdAtMs: row.createdAtMs,
		updatedAtMs: row.updatedAtMs
	};
	if (row.phase === "reserved") return Object.freeze({
		...base,
		phase: "reserved",
		revision: 0
	});
	if (row.phase === "requested") return Object.freeze({
		...base,
		phase: "requested",
		revision: 1,
		requested: Object.freeze({ targetTurn: row.requested.targetTurn })
	});
	if (row.phase === "committed") {
		const commit = "turnEndSeq" in row.commit ? Object.freeze({
			targetTurn: row.commit.targetTurn,
			turnEndSeq: row.commit.turnEndSeq
		}) : "decidedEventSeq" in row.commit ? Object.freeze({
			approvalId: row.commit.approvalId,
			outcome: row.commit.outcome,
			decidedEventSeq: row.commit.decidedEventSeq
		}) : "created" in row.commit ? Object.freeze({
			created: true,
			...row.commit.agentPreset === void 0 ? {} : { agentPreset: row.commit.agentPreset }
		}) : "selectedPreset" in row.commit ? Object.freeze({ selectedPreset: row.commit.selectedPreset }) : "selectedModel" in row.commit ? Object.freeze({ selectedModel: Object.freeze({
			provider: row.commit.selectedModel.provider,
			model: row.commit.selectedModel.model,
			...row.commit.selectedModel.reasoningEffort === void 0 ? {} : { reasoningEffort: row.commit.selectedModel.reasoningEffort }
		}) }) : "forked" in row.commit ? Object.freeze({
			forked: true,
			childSessionId: row.commit.childSessionId
		}) : "revokedRuleId" in row.commit ? Object.freeze({ revokedRuleId: row.commit.revokedRuleId }) : "budgetSet" in row.commit ? Object.freeze({
			budgetSet: true,
			maxTotalTokens: row.commit.maxTotalTokens
		}) : Object.freeze({
			sessionEventSeq: row.commit.sessionEventSeq,
			messageId: row.commit.messageId
		});
		return Object.freeze({
			...base,
			phase: "committed",
			revision: row.revision,
			commit
		});
	}
	return Object.freeze({
		...base,
		phase: "rejected",
		revision: 1,
		rejection: Object.freeze({ code: row.rejection.code })
	});
}
/** Package-private journal owner used by the Remote control service. */
var RemoteCommandJournal = class {
	domain;
	now;
	correlation;
	table;
	operationTails = /* @__PURE__ */ new Map();
	admissionOpen = true;
	/**
	* @param domain - already-open authoritative command domain.
	* @param now - monotonic-enough wall clock for audit timestamps.
	* @param correlation - opaque correlation factory.
	*/
	constructor(domain, now = Date.now, correlation = randomUUID) {
		this.domain = domain;
		this.now = now;
		this.correlation = correlation;
		this.table = domain.table("commands");
		for (const [key, row] of this.table.entries()) if (key !== row.commandId) throw new Error(`remote command journal key '${key}' does not match stored commandId '${row.commandId}'`);
	}
	/**
	* Durably reserve a globally unique command before any business effect.
	* @param rawBinding - authenticated semantic identity.
	* @returns created, pending, terminal replay, or conflict.
	*/
	reserve(rawBinding) {
		const binding = remoteCommandBindingSchema.parse(rawBinding);
		return this.enqueue(binding.commandId, async () => {
			const current = this.table.get(binding.commandId);
			if (current !== void 0) {
				if (!sameBinding(current, binding)) return Object.freeze({ kind: "conflict" });
				const row = snapshotRow(current);
				return row.phase === "reserved" || row.phase === "requested" ? Object.freeze({
					kind: "pending",
					row
				}) : Object.freeze({
					kind: "replay",
					row
				});
			}
			const now = this.checkedNow();
			const row = remoteCommandRowSchema.parse({
				...binding,
				correlation: this.correlation(),
				phase: "reserved",
				revision: 0,
				createdAtMs: now,
				updatedAtMs: now
			});
			await this.table.put(binding.commandId, row);
			return Object.freeze({
				kind: "created",
				row: snapshotRow(row)
			});
		});
	}
	/**
	* Read after earlier work on the same ID has settled.
	* @param commandId - Host-global identity.
	* @returns immutable row snapshot or absence.
	*/
	lookup(commandId) {
		return this.enqueue(commandId, () => {
			const row = this.table.get(commandId);
			return Promise.resolve(row === void 0 ? void 0 : snapshotRow(row));
		});
	}
	/**
	* Persist that one exact Stop reached the synchronous Agent cancellation owner.
	* @param commandId - reserved Host-global identity.
	* @param expectedFingerprint - fingerprint captured at reservation.
	* @param rawRequested - exact turn passed to the Agent owner.
	* @returns immutable non-terminal requested row.
	*/
	markRequested(commandId, expectedFingerprint, rawRequested) {
		const requested = { targetTurn: rawRequested.targetTurn };
		return this.enqueue(commandId, async () => {
			const current = this.requireBound(commandId, expectedFingerprint);
			if (current.operation !== "stop" || current.targetTurn !== requested.targetTurn) throw new Error(`remote command '${commandId}' is not the requested Stop target`);
			if (current.phase === "committed" || current.phase === "rejected") throw new Error(`remote command '${commandId}' is already terminal`);
			if (current.phase === "requested") return snapshotRow(current);
			return snapshotRow(await this.table.update(commandId, (observed) => {
				if (observed.phase !== "reserved" || observed.requestFingerprint !== expectedFingerprint) throw new Error(`remote command '${commandId}' changed before Stop request`);
				return remoteCommandRowSchema.parse({
					...observed,
					phase: "requested",
					revision: 1,
					updatedAtMs: Math.max(this.checkedNow(), observed.updatedAtMs),
					requested
				});
			}));
		});
	}
	/**
	* Index one durable Session fact; repeating the exact terminal fact is safe.
	* @param commandId - reserved Host-global identity.
	* @param expectedFingerprint - fingerprint captured at reservation.
	* @param rawCommit - physically durable Session correlation.
	* @returns immutable committed row.
	*/
	commit(commandId, expectedFingerprint, rawCommit) {
		const commit = remoteCommandCommitSchema.parse(rawCommit);
		return this.enqueue(commandId, async () => {
			const current = this.requireBound(commandId, expectedFingerprint);
			if (current.phase === "rejected") throw new Error(`remote command '${commandId}' is already rejected`);
			if (current.phase === "committed") {
				if (!sameCommit(current.commit, commit)) throw new Error(`remote command '${commandId}' commit correlation changed`);
				return snapshotRow(current);
			}
			return snapshotRow(await this.table.update(commandId, (observed) => {
				const expectedPhase = observed.operation === "stop" ? "requested" : "reserved";
				if (observed.phase !== expectedPhase || observed.requestFingerprint !== expectedFingerprint) throw new Error(`remote command '${commandId}' changed before commit`);
				return remoteCommandRowSchema.parse({
					...observed,
					phase: "committed",
					revision: observed.operation === "stop" ? 2 : 1,
					updatedAtMs: Math.max(this.checkedNow(), observed.updatedAtMs),
					commit
				});
			}));
		});
	}
	/**
	* Store one definitive pre-effect rejection; repeating the same code is safe.
	* @param commandId - reserved Host-global identity.
	* @param expectedFingerprint - fingerprint captured at reservation.
	* @param rawRejection - stable machine-readable rejection.
	* @returns immutable rejected row.
	*/
	reject(commandId, expectedFingerprint, rawRejection) {
		const rejection = remoteCommandRejectionSchema.parse(rawRejection);
		return this.enqueue(commandId, async () => {
			const current = this.requireBound(commandId, expectedFingerprint);
			if (current.phase === "committed") throw new Error(`remote command '${commandId}' is already committed`);
			if (current.phase === "requested") throw new Error(`remote command '${commandId}' already crossed the effect boundary`);
			if (current.phase === "rejected") {
				if (current.rejection.code !== rejection.code) throw new Error(`remote command '${commandId}' rejection changed`);
				return snapshotRow(current);
			}
			return snapshotRow(await this.table.update(commandId, (observed) => {
				if (observed.phase !== "reserved" || observed.requestFingerprint !== expectedFingerprint) throw new Error(`remote command '${commandId}' changed before rejection`);
				return remoteCommandRowSchema.parse({
					...observed,
					phase: "rejected",
					revision: 1,
					updatedAtMs: Math.max(this.checkedNow(), observed.updatedAtMs),
					rejection
				});
			}));
		});
	}
	/** Stop admission and drain all per-ID operations. */
	async close() {
		this.admissionOpen = false;
		await Promise.all(this.operationTails.values());
		await this.domain.close();
	}
	requireBound(commandId, fingerprint) {
		const row = this.table.get(commandId);
		if (row === void 0) throw new Error(`remote command '${commandId}' is not reserved`);
		if (row.commandId !== commandId || row.requestFingerprint !== fingerprint) throw new Error(`remote command '${commandId}' binding mismatch`);
		return row;
	}
	checkedNow() {
		const now = this.now();
		if (!Number.isSafeInteger(now) || now < 0) throw new Error(`remote command journal clock is invalid: ${String(now)}`);
		return now;
	}
	enqueue(commandId, operation) {
		if (!this.admissionOpen) return Promise.reject(/* @__PURE__ */ new Error("remote command journal is disposing"));
		const result = (this.operationTails.get(commandId) ?? Promise.resolve()).then(operation);
		const tail = result.then(() => void 0, () => void 0);
		this.operationTails.set(commandId, tail);
		return result.finally(() => {
			if (this.operationTails.get(commandId) === tail) this.operationTails.delete(commandId);
		});
	}
};
//#endregion
//#region src/control/lease.ts
/** Durable epoch plus process-local Session control lease implementation. */
const UINT64_MAX = 18446744073709551615n;
const sessionIdPattern = /^.{1,256}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
function incrementEpoch(epoch) {
	const value = epoch === void 0 ? 0n : BigInt(epoch);
	if (value >= UINT64_MAX) throw new Error("remote control epoch overflow");
	return String(value + 1n);
}
function tokenMatches(expected, actual) {
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(actual, "utf8");
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function snapshotLease(lease) {
	return Object.freeze({
		sessionId: lease.sessionId,
		holderDeviceId: lease.holderDeviceId,
		epoch: lease.epoch,
		token: lease.token,
		expiresAtMs: lease.expiresAtMs
	});
}
/** Package-private lease owner used by the Remote control service. */
var RemoteControlLeases = class {
	domain;
	defaultTtlMs;
	now;
	nextToken;
	table;
	live = /* @__PURE__ */ new Map();
	operationTails = /* @__PURE__ */ new Map();
	admissionOpen = true;
	/**
	* @param domain - already-open durable epoch domain.
	* @param defaultTtlMs - lease lifetime applied to acquire/renew/transfer.
	* @param now - Host wall clock sampled at every operation.
	* @param nextToken - cryptographically random token factory.
	*/
	constructor(domain, defaultTtlMs, now = Date.now, nextToken = () => randomBytes(32).toString("base64url")) {
		this.domain = domain;
		this.defaultTtlMs = defaultTtlMs;
		this.now = now;
		this.nextToken = nextToken;
		this.table = domain.table("sessions");
		for (const [key, row] of this.table.entries()) if (key !== row.sessionId) throw new Error(`remote control fence key '${key}' does not match stored sessionId '${row.sessionId}'`);
	}
	/**
	* Acquire an unheld or expired Session; same-holder extension uses renew.
	* @param sessionId - ordinary Session identity.
	* @param deviceId - authenticated stable device identity.
	* @returns new lease or held conflict.
	*/
	acquire(sessionId, deviceId) {
		this.validateIdentity(sessionId, deviceId);
		return this.enqueue(sessionId, async () => {
			const current = this.live.get(sessionId);
			const now = this.checkedNow();
			if (current !== void 0 && now < current.expiresAtMs) {
				if (current.holderDeviceId === deviceId) return Object.freeze({
					ok: true,
					lease: snapshotLease(current)
				});
				return Object.freeze({
					ok: false,
					reason: "held-by-other"
				});
			}
			const epoch = await this.advanceEpoch(sessionId);
			const lease = this.createLease(sessionId, deviceId, epoch, now);
			this.live.set(sessionId, lease);
			return Object.freeze({
				ok: true,
				lease: snapshotLease(lease)
			});
		});
	}
	/**
	* Extend one exact, unexpired holder without changing epoch or token.
	* @param rawLease - exact current holder fence.
	* @returns renewed lease or a stable fence failure.
	*/
	renew(rawLease) {
		const lease = this.validateProof(rawLease);
		return this.enqueue(lease.sessionId, async () => {
			const current = this.live.get(lease.sessionId);
			const failure = this.fenceFailure(current, lease);
			if (failure !== void 0) {
				if (failure === "expired" && current !== void 0) await this.expire(current);
				return Object.freeze({
					ok: false,
					reason: failure
				});
			}
			if (current === void 0) throw new Error("remote control lease disappeared after a successful fence");
			const renewed = Object.freeze({
				...current,
				expiresAtMs: this.checkedNow() + this.defaultTtlMs
			});
			this.live.set(lease.sessionId, renewed);
			return Object.freeze({
				ok: true,
				lease: snapshotLease(renewed)
			});
		});
	}
	/**
	* Atomically bump the fence and hand control to another authenticated device.
	* @param rawLease - exact current holder fence.
	* @param nextDeviceId - authenticated next holder.
	* @returns next lease or a stable fence failure.
	*/
	transfer(rawLease, nextDeviceId) {
		const lease = this.validateProof(rawLease);
		remoteDeviceIdSchema.parse(nextDeviceId);
		return this.enqueue(lease.sessionId, async () => {
			const current = this.live.get(lease.sessionId);
			const failure = this.fenceFailure(current, lease);
			if (failure !== void 0) {
				if (failure === "expired" && current !== void 0) await this.expire(current);
				return Object.freeze({
					ok: false,
					reason: failure
				});
			}
			const epoch = await this.advanceEpoch(lease.sessionId);
			const transferred = this.createLease(lease.sessionId, nextDeviceId, epoch, this.checkedNow());
			this.live.set(lease.sessionId, transferred);
			return Object.freeze({
				ok: true,
				lease: snapshotLease(transferred)
			});
		});
	}
	/**
	* Release an exact current lease and persist a strictly larger tombstone epoch.
	* @param rawLease - exact current holder fence.
	* @returns released postcondition or a stable fence failure.
	*/
	release(rawLease) {
		const lease = this.validateProof(rawLease);
		return this.enqueue(lease.sessionId, async () => {
			const current = this.live.get(lease.sessionId);
			const failure = this.fenceFailure(current, lease);
			if (failure !== void 0) {
				if (failure === "expired" && current !== void 0) await this.expire(current);
				return Object.freeze({
					ok: false,
					reason: failure
				});
			}
			await this.advanceEpoch(lease.sessionId);
			this.live.delete(lease.sessionId);
			return Object.freeze({ ok: true });
		});
	}
	/**
	* Bump and clear every live lease owned by a revoked or reprofiled device.
	* @param deviceId - stable authorization subject to invalidate.
	*/
	async invalidateDevice(deviceId) {
		remoteDeviceIdSchema.parse(deviceId);
		const sessions = [...this.live.values()].filter((lease) => lease.holderDeviceId === deviceId).map((lease) => lease.sessionId);
		await Promise.all(sessions.map((sessionId) => this.enqueue(sessionId, async () => {
			if (this.live.get(sessionId)?.holderDeviceId !== deviceId) return;
			await this.advanceEpoch(sessionId);
			this.live.delete(sessionId);
		})));
	}
	/**
	* Recheck authorization and the exact lease immediately before a synchronous
	* effect admission, without an await boundary between the two callbacks.
	* @param rawLease - exact current holder fence.
	* @param authorize - synchronous exact capability and authority-epoch check.
	* @param effect - synchronous DSH owner admission.
	* @returns effect value or a stable lease failure.
	*/
	admit(rawLease, authorize, effect) {
		const lease = this.validateProof(rawLease);
		return this.enqueue(lease.sessionId, async () => {
			const current = this.live.get(lease.sessionId);
			const failure = this.fenceFailure(current, lease);
			if (failure !== void 0) {
				if (failure === "expired" && current !== void 0) await this.expire(current);
				return Object.freeze({
					ok: false,
					reason: failure
				});
			}
			authorize();
			const value = effect();
			if (value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") throw new TypeError("remote control effect admission must be synchronous");
			return Object.freeze({
				ok: true,
				value
			});
		});
	}
	/** Stop admission, drain Session queues, clear all secrets, and close the domain. */
	async close() {
		this.admissionOpen = false;
		await Promise.all(this.operationTails.values());
		this.live.clear();
		await this.domain.close();
	}
	fenceFailure(current, presented) {
		if (current === void 0) return "unheld";
		if (this.checkedNow() >= current.expiresAtMs) return "expired";
		if (current.sessionId !== presented.sessionId || current.holderDeviceId !== presented.holderDeviceId || current.epoch !== presented.epoch || !tokenMatches(current.token, presented.token)) return "stale-fence";
	}
	async expire(current) {
		await this.advanceEpoch(current.sessionId);
		if (this.live.get(current.sessionId) === current) this.live.delete(current.sessionId);
	}
	async advanceEpoch(sessionId) {
		const current = this.table.get(sessionId);
		const epoch = incrementEpoch(current?.lastEpoch);
		const next = Object.freeze({
			sessionId,
			lastEpoch: epoch
		});
		if (current === void 0) await this.table.put(sessionId, next);
		else await this.table.update(sessionId, (observed) => {
			if (observed.lastEpoch !== current.lastEpoch || observed.sessionId !== sessionId) throw new Error(`remote control fence '${sessionId}' changed before epoch allocation`);
			return next;
		});
		return epoch;
	}
	createLease(sessionId, holderDeviceId, epoch, now) {
		const token = this.nextToken();
		if (!tokenPattern.test(token)) throw new Error("remote control token factory returned a non-canonical token");
		return Object.freeze({
			sessionId,
			holderDeviceId,
			epoch,
			token,
			expiresAtMs: now + this.defaultTtlMs
		});
	}
	validateIdentity(sessionId, deviceId) {
		if (!sessionIdPattern.test(sessionId)) throw new TypeError("remote control sessionId is invalid");
		remoteDeviceIdSchema.parse(deviceId);
	}
	validateProof(lease) {
		this.validateIdentity(lease.sessionId, lease.holderDeviceId);
		remoteControlEpochSchema.parse(lease.epoch);
		if (!tokenPattern.test(lease.token)) throw new TypeError("remote control token is invalid");
		return Object.freeze({ ...lease });
	}
	checkedNow() {
		const now = this.now();
		if (!Number.isSafeInteger(now) || now < 0) throw new Error(`remote control clock is invalid: ${String(now)}`);
		return now;
	}
	enqueue(sessionId, operation) {
		if (!this.admissionOpen) return Promise.reject(/* @__PURE__ */ new Error("remote control service is disposing"));
		const result = (this.operationTails.get(sessionId) ?? Promise.resolve()).then(operation);
		const tail = result.then(() => void 0, () => void 0);
		this.operationTails.set(sessionId, tail);
		return result.finally(() => {
			if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId);
		});
	}
};
//#endregion
//#region src/control/index.ts
/** Stable Cordis function-plugin name. */
const name = "host-remote-control";
/** Durable data-form dependency; the read-only Remote carrier remains independent. */
const inject = ["storageDomain"];
const Config = z.object({ leaseTtlMs: z.number().step(1).min(1e3).max(6e5).default(3e4) });
/** Concrete owner mounted behind `ctx.remoteControl`. */
var RemoteControlAuthority = class {
	journal;
	leases;
	constructor(journal, leases) {
		this.journal = journal;
		this.leases = leases;
	}
	reserveCommand(binding) {
		return this.journal.reserve(binding);
	}
	lookupCommand(commandId) {
		return this.journal.lookup(commandId);
	}
	markCommandRequested(commandId, expectedFingerprint, requested) {
		return this.journal.markRequested(commandId, expectedFingerprint, requested);
	}
	commitCommand(commandId, expectedFingerprint, commit) {
		return this.journal.commit(commandId, expectedFingerprint, commit);
	}
	rejectCommand(commandId, expectedFingerprint, rejection) {
		return this.journal.reject(commandId, expectedFingerprint, rejection);
	}
	acquireControl(sessionId, deviceId) {
		return this.leases.acquire(sessionId, deviceId);
	}
	renewControl(lease) {
		return this.leases.renew(lease);
	}
	transferControl(lease, nextDeviceId) {
		return this.leases.transfer(lease, nextDeviceId);
	}
	releaseControl(lease) {
		return this.leases.release(lease);
	}
	invalidateDevice(deviceId) {
		return this.leases.invalidateDevice(deviceId);
	}
	admit(lease, authorize, effect) {
		return this.leases.admit(lease, authorize, effect);
	}
	async close() {
		await Promise.all([this.leases.close(), this.journal.close()]);
	}
};
/**
* Open both durable authorities atomically with respect to service publication,
* then retract the service before draining them during plugin disposal.
* @param ctx - Host Context carrying the routed storage-domain facility.
* @param config - bounded control-lease policy.
*/
async function apply(ctx, config) {
	await ctx.effect(async () => {
		const journalDomain = await ctx.storageDomain.open(remoteCommandJournalSpec);
		let fenceDomain;
		try {
			fenceDomain = await ctx.storageDomain.open(remoteControlFenceSpec);
			const authority = new RemoteControlAuthority(new RemoteCommandJournal(journalDomain), new RemoteControlLeases(fenceDomain, config.leaseTtlMs ?? 3e4));
			const disposeService = ctx.provide("remoteControl", authority);
			return async () => {
				disposeService();
				await authority.close();
			};
		} catch (error) {
			await Promise.all([journalDomain.close(), ...fenceDomain === void 0 ? [] : [fenceDomain.close()]]);
			throw error;
		}
	}, "host-remote-control: durable journal and lease owner");
}
//#endregion
export { Config, apply, fingerprintRemoteApprovalDecision, fingerprintRemoteCreateSession, fingerprintRemoteForkSession, fingerprintRemoteRevokeApprovalRule, fingerprintRemoteSelectAgentPreset, fingerprintRemoteSelectModel, fingerprintRemoteSendInput, fingerprintRemoteSetSessionBudget, fingerprintRemoteStop, inject, name };

//# sourceMappingURL=control.mjs.map