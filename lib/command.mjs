import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy/api";
import "@deepseek-ai/dsh-session";
import { fingerprintRemoteApprovalDecision, fingerprintRemoteCreateSession, fingerprintRemoteForkSession, fingerprintRemoteRevokeApprovalRule, fingerprintRemoteSelectAgentPreset, fingerprintRemoteSelectModel, fingerprintRemoteSendInput, fingerprintRemoteSetSessionBudget, fingerprintRemoteStop } from "@w2112515/dsh-remote-host/control";
//#region src/command/executor.ts
function terminalFromRow(row, replayed) {
	return row.phase === "committed" ? Object.freeze({
		outcome: "committed",
		commandId: row.commandId,
		replayed
	}) : Object.freeze({
		outcome: "rejected",
		commandId: row.commandId,
		replayed,
		errorCode: row.rejection.code
	});
}
function stopTerminalFromRow(row, expectedActivityRevision, replayed) {
	return row.phase === "committed" ? Object.freeze({
		outcome: "stopped",
		commandId: row.commandId,
		expectedActivityRevision,
		replayed
	}) : Object.freeze({
		outcome: "rejected",
		commandId: row.commandId,
		expectedActivityRevision,
		replayed,
		errorCode: row.rejection.code
	});
}
/** Package-private command owner mounted behind `ctx.remoteCommands`. */
var RemoteCommandExecutor = class {
	prompts;
	stops;
	control;
	logger;
	stopSettlementTimeoutMs;
	approvals;
	sessionAdmin;
	policy;
	inFlight = /* @__PURE__ */ new Map();
	stopInFlight = /* @__PURE__ */ new Map();
	approvalInFlight = /* @__PURE__ */ new Map();
	adminInFlight = /* @__PURE__ */ new Map();
	admissionOpen = true;
	/**
	* @param prompts - Host-only two-phase ApiProxy admission face.
	* @param stops - Host-only exact-turn cancellation and physical terminal inspection.
	* @param control - durable idempotency and control-fence owner.
	* @param logger - contained callback and post-commit wake diagnostics.
	* @param stopSettlementTimeoutMs - caller-visible wait before returning honest UNKNOWN while ownership continues.
	* @param approvals - Host-only approval decision face.
	* @param sessionAdmin - Host-only Session create/preset-select face (S-mode-select).
	* @param policy - lazy Host session-policy face (S-policy); absent keeps policy commands refused.
	*/
	constructor(prompts, stops, control, logger, stopSettlementTimeoutMs = 3e4, approvals, sessionAdmin, policy) {
		this.prompts = prompts;
		this.stops = stops;
		this.control = control;
		this.logger = logger;
		this.stopSettlementTimeoutMs = stopSettlementTimeoutMs;
		this.approvals = approvals;
		this.sessionAdmin = sessionAdmin;
		this.policy = policy;
	}
	async sendInput(authority, command, onReceived) {
		if (!this.admissionOpen) throw new Error("remote command executor is disposing");
		const requestFingerprint = fingerprintRemoteSendInput({
			sessionId: command.sessionId,
			text: command.text,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			controlEpoch: command.control.epoch,
			...command.attachmentIds === void 0 ? {} : { attachmentIds: command.attachmentIds }
		});
		const binding = Object.freeze({
			commandId: command.commandId,
			operation: "send_input",
			sessionId: command.sessionId,
			requestFingerprint,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			controlEpoch: command.control.epoch
		});
		const reservation = await this.control.reserveCommand(binding);
		if (reservation.kind === "conflict") return Object.freeze({
			outcome: "rejected",
			commandId: command.commandId,
			replayed: true,
			errorCode: "command-id-reused"
		});
		if (reservation.kind === "replay") {
			if (reservation.row.phase === "rejected") return terminalFromRow(reservation.row, true);
			return this.replayCommitted(reservation.row);
		}
		if (reservation.row.phase !== "reserved") return this.unknown(command, "journal-operation-conflict", true);
		const replayed = reservation.kind === "pending";
		this.notifyReceived(onReceived, {
			outcome: "received",
			commandId: command.commandId,
			replayed
		});
		const existing = this.inFlight.get(command.commandId);
		if (existing !== void 0) return this.withReplay(await existing, true);
		const operation = this.execute(authority, command, reservation.row, replayed);
		this.inFlight.set(command.commandId, operation);
		try {
			return this.withReplay(await operation, replayed);
		} finally {
			if (this.inFlight.get(command.commandId) === operation) this.inFlight.delete(command.commandId);
		}
	}
	async stop(authority, command, onRequested) {
		if (!this.admissionOpen) throw new Error("remote command executor is disposing");
		const requestFingerprint = fingerprintRemoteStop({
			sessionId: command.sessionId,
			targetTurn: command.expectedActivityRevision,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			controlEpoch: command.control.epoch
		});
		const binding = Object.freeze({
			commandId: command.commandId,
			operation: "stop",
			sessionId: command.sessionId,
			requestFingerprint,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			controlEpoch: command.control.epoch,
			targetTurn: command.expectedActivityRevision
		});
		const reservation = await this.control.reserveCommand(binding);
		if (reservation.kind === "conflict") return this.stopRejected(command, "command-id-reused", true);
		if (reservation.kind === "replay") {
			if (reservation.row.phase === "rejected") return stopTerminalFromRow(reservation.row, command.expectedActivityRevision, true);
			return this.replayStopped(command, reservation.row);
		}
		if (reservation.row.phase === "requested") this.notifyStopRequested(onRequested, command, true);
		const existing = this.stopInFlight.get(command.commandId);
		if (existing !== void 0) return this.awaitStop(existing, command, true);
		const operation = this.executeStop(authority, command, reservation.row, onRequested);
		this.stopInFlight.set(command.commandId, operation);
		operation.finally(() => {
			if (this.stopInFlight.get(command.commandId) === operation) this.stopInFlight.delete(command.commandId);
		}).catch(() => {});
		return this.awaitStop(operation, command, reservation.kind === "pending");
	}
	async decideApproval(authority, command, onReceived) {
		if (!this.admissionOpen) throw new Error("remote command executor is disposing");
		const requestFingerprint = fingerprintRemoteApprovalDecision({
			sessionId: command.sessionId,
			approvalId: command.approvalId,
			approvalRevision: command.approvalRevision,
			outcome: command.outcome,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			...command.grantSameKind === true ? { grantSameKind: true } : {}
		});
		const binding = Object.freeze({
			commandId: command.commandId,
			operation: "decide_approval",
			sessionId: command.sessionId,
			requestFingerprint,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			approvalId: command.approvalId,
			approvalRevision: command.approvalRevision,
			approvalOutcome: command.outcome
		});
		const reservation = await this.control.reserveCommand(binding);
		if (reservation.kind === "conflict") return Object.freeze({
			outcome: "rejected",
			commandId: command.commandId,
			replayed: true,
			errorCode: "command-id-reused"
		});
		if (reservation.kind === "replay") {
			if (reservation.row.phase === "rejected") return terminalFromRow(reservation.row, true);
			return this.replayApproval(command, reservation.row);
		}
		if (reservation.row.phase !== "reserved") return this.unknown(command, "journal-operation-conflict", true);
		const replayed = reservation.kind === "pending";
		this.notifyReceived(onReceived, {
			outcome: "received",
			commandId: command.commandId,
			replayed
		});
		const existing = this.approvalInFlight.get(command.commandId);
		if (existing !== void 0) return this.withReplay(await existing, true);
		const operation = this.executeApproval(authority, command, reservation.row, replayed);
		this.approvalInFlight.set(command.commandId, operation);
		try {
			return this.withReplay(await operation, replayed);
		} finally {
			if (this.approvalInFlight.get(command.commandId) === operation) this.approvalInFlight.delete(command.commandId);
		}
	}
	async createSession(authority, command, onReceived) {
		if (!this.admissionOpen) throw new Error("remote command executor is disposing");
		const requestFingerprint = fingerprintRemoteCreateSession({
			sessionId: command.sessionId,
			agentPreset: command.agentPreset,
			workspaceId: command.workspaceId,
			newWorkspaceName: command.newWorkspaceName,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch
		});
		const binding = Object.freeze({
			commandId: command.commandId,
			operation: "create_session",
			sessionId: command.sessionId,
			requestFingerprint,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			...command.agentPreset === void 0 ? {} : { agentPreset: command.agentPreset }
		});
		return this.runAdminCommand(authority, command, binding, onReceived, async () => {
			if (this.sessionAdmin === void 0) return {
				ok: false,
				errorCode: "session-admin-unavailable"
			};
			try {
				return await this.sessionAdmin.createSession({
					sessionId: command.sessionId,
					...command.agentPreset === void 0 ? {} : { agentPreset: command.agentPreset },
					...command.workspaceId === void 0 ? {} : { workspaceId: command.workspaceId },
					...command.newWorkspaceName === void 0 ? {} : { newWorkspaceName: command.newWorkspaceName }
				});
			} catch {
				return {
					ok: false,
					errorCode: "session-admin-unavailable"
				};
			}
		}, async () => {
			if (this.sessionAdmin === void 0) return false;
			try {
				return (await this.sessionAdmin.createSession({
					sessionId: command.sessionId,
					...command.agentPreset === void 0 ? {} : { agentPreset: command.agentPreset },
					...command.workspaceId === void 0 ? {} : { workspaceId: command.workspaceId },
					...command.newWorkspaceName === void 0 ? {} : { newWorkspaceName: command.newWorkspaceName }
				})).ok;
			} catch {
				return false;
			}
		}, (result) => ({
			created: true,
			...result.agentPreset === void 0 ? {} : { agentPreset: result.agentPreset }
		}));
	}
	async selectAgentPreset(authority, command, onReceived) {
		if (!this.admissionOpen) throw new Error("remote command executor is disposing");
		const requestFingerprint = fingerprintRemoteSelectAgentPreset({
			sessionId: command.sessionId,
			agentPreset: command.agentPreset,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch
		});
		const binding = Object.freeze({
			commandId: command.commandId,
			operation: "select_agent_preset",
			sessionId: command.sessionId,
			requestFingerprint,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			agentPreset: command.agentPreset
		});
		return this.runAdminCommand(authority, command, binding, onReceived, async () => {
			if (this.sessionAdmin === void 0) return {
				ok: false,
				errorCode: "session-admin-unavailable"
			};
			try {
				return await this.sessionAdmin.selectAgentPreset({
					sessionId: command.sessionId,
					agentPreset: command.agentPreset
				});
			} catch {
				return {
					ok: false,
					errorCode: "session-admin-unavailable"
				};
			}
		}, async () => {
			if (this.sessionAdmin === void 0) return false;
			try {
				return (await this.sessionAdmin.selectAgentPreset({
					sessionId: command.sessionId,
					agentPreset: command.agentPreset
				})).ok;
			} catch {
				return false;
			}
		}, () => ({ selectedPreset: command.agentPreset }));
	}
	async selectModel(authority, command, onReceived) {
		if (!this.admissionOpen) throw new Error("remote command executor is disposing");
		const modelSelection = Object.freeze({
			provider: command.provider,
			model: command.model,
			...command.reasoningEffort === void 0 ? {} : { reasoningEffort: command.reasoningEffort }
		});
		const requestFingerprint = fingerprintRemoteSelectModel({
			sessionId: command.sessionId,
			provider: command.provider,
			model: command.model,
			reasoningEffort: command.reasoningEffort,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			controlEpoch: command.control.epoch
		});
		const binding = Object.freeze({
			commandId: command.commandId,
			operation: "select_model",
			sessionId: command.sessionId,
			requestFingerprint,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			controlEpoch: command.control.epoch,
			modelSelection
		});
		const reservation = await this.control.reserveCommand(binding);
		if (reservation.kind === "conflict") return Object.freeze({
			outcome: "rejected",
			commandId: command.commandId,
			replayed: true,
			errorCode: "command-id-reused"
		});
		if (reservation.kind === "replay") {
			if (reservation.row.phase === "rejected") return terminalFromRow(reservation.row, true);
			return await this.reproveSelectModel(command) ? terminalFromRow(reservation.row, true) : this.unknown(command, "committed-fact-unavailable", true);
		}
		if (reservation.row.phase !== "reserved") return this.unknown(command, "journal-operation-conflict", true);
		const replayed = reservation.kind === "pending";
		this.notifyReceived(onReceived, {
			outcome: "received",
			commandId: command.commandId,
			replayed
		});
		const existing = this.adminInFlight.get(command.commandId);
		if (existing !== void 0) return this.withReplay(await existing, true);
		const operation = this.executeSelectModel(authority, command, reservation.row);
		this.adminInFlight.set(command.commandId, operation);
		try {
			return this.withReplay(await operation, replayed);
		} finally {
			if (this.adminInFlight.get(command.commandId) === operation) this.adminInFlight.delete(command.commandId);
		}
	}
	async forkSession(authority, command, onReceived) {
		if (!this.admissionOpen) throw new Error("remote command executor is disposing");
		const requestFingerprint = fingerprintRemoteForkSession({
			sessionId: command.sessionId,
			childSessionId: command.childSessionId,
			atSeq: command.atSeq,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch
		});
		const binding = Object.freeze({
			commandId: command.commandId,
			operation: "fork_session",
			sessionId: command.sessionId,
			requestFingerprint,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			childSessionId: command.childSessionId,
			...command.atSeq === void 0 ? {} : { forkAtSeq: command.atSeq }
		});
		return this.runAdminCommand(authority, command, binding, onReceived, async () => {
			if (this.sessionAdmin === void 0) return {
				ok: false,
				errorCode: "session-admin-unavailable"
			};
			try {
				return await this.sessionAdmin.forkSession({
					sessionId: command.sessionId,
					childSessionId: command.childSessionId,
					...command.atSeq === void 0 ? {} : { atSeq: command.atSeq }
				});
			} catch {
				return {
					ok: false,
					errorCode: "session-admin-unavailable"
				};
			}
		}, async () => {
			if (this.sessionAdmin === void 0) return false;
			try {
				return (await this.sessionAdmin.forkSession({
					sessionId: command.sessionId,
					childSessionId: command.childSessionId,
					...command.atSeq === void 0 ? {} : { atSeq: command.atSeq }
				})).ok;
			} catch {
				return false;
			}
		}, () => ({
			forked: true,
			childSessionId: command.childSessionId
		}));
	}
	async revokeApprovalRule(authority, command, onReceived) {
		if (!this.admissionOpen) throw new Error("remote command executor is disposing");
		const requestFingerprint = fingerprintRemoteRevokeApprovalRule({
			sessionId: command.sessionId,
			ruleId: command.ruleId,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch
		});
		const binding = Object.freeze({
			commandId: command.commandId,
			operation: "revoke_approval_rule",
			sessionId: command.sessionId,
			requestFingerprint,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			ruleId: command.ruleId
		});
		return this.runAdminCommand(authority, command, binding, onReceived, async () => {
			const policy = this.policy?.();
			if (policy === void 0) return {
				ok: false,
				errorCode: "approval-policy-unavailable"
			};
			try {
				return await policy.revokeRule({
					sessionId: command.sessionId,
					ruleId: command.ruleId
				});
			} catch {
				return {
					ok: false,
					errorCode: "approval-policy-unavailable"
				};
			}
		}, () => {
			const policy = this.policy?.();
			if (policy === void 0) return Promise.resolve(false);
			try {
				return Promise.resolve(!policy.isRuleActive({
					sessionId: command.sessionId,
					ruleId: command.ruleId
				}));
			} catch {
				return Promise.resolve(false);
			}
		}, () => ({ revokedRuleId: command.ruleId }));
	}
	async setSessionBudget(authority, command, onReceived) {
		if (!this.admissionOpen) throw new Error("remote command executor is disposing");
		const requestFingerprint = fingerprintRemoteSetSessionBudget({
			sessionId: command.sessionId,
			maxTotalTokens: command.maxTotalTokens,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch
		});
		const binding = Object.freeze({
			commandId: command.commandId,
			operation: "set_session_budget",
			sessionId: command.sessionId,
			requestFingerprint,
			deviceId: authority.deviceId,
			authorityEpoch: authority.authorityEpoch,
			maxTotalTokens: command.maxTotalTokens
		});
		return this.runAdminCommand(authority, command, binding, onReceived, async () => {
			const policy = this.policy?.();
			if (policy === void 0) return {
				ok: false,
				errorCode: "approval-policy-unavailable"
			};
			try {
				return await policy.setBudget({
					sessionId: command.sessionId,
					maxTotalTokens: command.maxTotalTokens
				});
			} catch {
				return {
					ok: false,
					errorCode: "approval-policy-unavailable"
				};
			}
		}, async () => {
			const policy = this.policy?.();
			if (policy === void 0) return false;
			try {
				if (policy.currentBudget(command.sessionId) === command.maxTotalTokens) return true;
				return (await policy.setBudget({
					sessionId: command.sessionId,
					maxTotalTokens: command.maxTotalTokens
				})).ok;
			} catch {
				return false;
			}
		}, () => ({
			budgetSet: true,
			maxTotalTokens: command.maxTotalTokens
		}));
	}
	async reproveSelectModel(command) {
		if (this.sessionAdmin === void 0) return false;
		try {
			return (await this.sessionAdmin.selectModel({
				sessionId: command.sessionId,
				provider: command.provider,
				model: command.model,
				...command.reasoningEffort === void 0 ? {} : { reasoningEffort: command.reasoningEffort }
			})).ok;
		} catch {
			return false;
		}
	}
	async executeSelectModel(authority, command, row) {
		if (command.control.sessionId !== command.sessionId || command.control.holderDeviceId !== authority.deviceId) return this.reject(row, "invalid-control-proof");
		const preflight = await this.authorizedAdmission(command, authority, () => void 0);
		if (preflight.kind === "threw") return this.reject(row, "authorization-denied");
		if (preflight.kind === "refused") return this.reject(row, preflight.errorCode);
		const sessionAdmin = this.sessionAdmin;
		if (sessionAdmin === void 0) return this.reject(row, "session-admin-unavailable");
		let result;
		try {
			result = await sessionAdmin.selectModel({
				sessionId: command.sessionId,
				provider: command.provider,
				model: command.model,
				...command.reasoningEffort === void 0 ? {} : { reasoningEffort: command.reasoningEffort }
			});
		} catch {
			return this.unknown(command, "session-admin-unavailable");
		}
		if (!result.ok) return this.reject(row, result.errorCode);
		try {
			await this.control.commitCommand(command.commandId, row.requestFingerprint, { selectedModel: {
				provider: command.provider,
				model: command.model,
				...command.reasoningEffort === void 0 ? {} : { reasoningEffort: command.reasoningEffort }
			} });
		} catch (error) {
			this.logger.warn(`remote-command: durable model selection committed but journal repair is pending: ${String(error)}`);
		}
		return Object.freeze({
			outcome: "committed",
			commandId: command.commandId,
			replayed: false
		});
	}
	/**
	* Shared reserve/dedup/execute/replay pipeline for the lease-free session
	* admin commands (S-mode-select, S-session-admin fork). Each owner call is
	* set-valued and idempotent, so a reserved-but-unproven row converges by
	* re-execution and a committed row is re-proven by the same call.
	*/
	async runAdminCommand(authority, command, binding, onReceived, effect, reprove, commit) {
		const reservation = await this.control.reserveCommand(binding);
		if (reservation.kind === "conflict") return Object.freeze({
			outcome: "rejected",
			commandId: command.commandId,
			replayed: true,
			errorCode: "command-id-reused"
		});
		if (reservation.kind === "replay") {
			if (reservation.row.phase === "rejected") return terminalFromRow(reservation.row, true);
			return await reprove() ? terminalFromRow(reservation.row, true) : this.unknown(command, "committed-fact-unavailable", true);
		}
		const reservedRow = reservation.row;
		if (reservedRow.phase !== "reserved") return this.unknown(command, "journal-operation-conflict", true);
		const replayed = reservation.kind === "pending";
		this.notifyReceived(onReceived, {
			outcome: "received",
			commandId: command.commandId,
			replayed
		});
		const existing = this.adminInFlight.get(command.commandId);
		if (existing !== void 0) return this.withReplay(await existing, true);
		const operation = (async () => {
			try {
				authority.authorize();
			} catch {
				return this.reject(reservedRow, "authorization-denied");
			}
			const result = await effect();
			if (!result.ok) return this.reject(reservedRow, result.errorCode);
			try {
				await this.control.commitCommand(command.commandId, reservedRow.requestFingerprint, commit(result));
			} catch (error) {
				this.logger.warn(`remote-command: durable session admin effect committed but journal repair is pending: ${String(error)}`);
			}
			return Object.freeze({
				outcome: "committed",
				commandId: command.commandId,
				replayed: false
			});
		})();
		this.adminInFlight.set(command.commandId, operation);
		try {
			return this.withReplay(await operation, replayed);
		} finally {
			if (this.adminInFlight.get(command.commandId) === operation) this.adminInFlight.delete(command.commandId);
		}
	}
	/** Stop new commands and await every accepted owner operation. */
	async close() {
		this.admissionOpen = false;
		await Promise.allSettled([
			...this.inFlight.values(),
			...this.stopInFlight.values(),
			...this.approvalInFlight.values(),
			...this.adminInFlight.values()
		]);
	}
	async execute(authority, command, row, reconcile) {
		const correlation = row.correlation;
		if (reconcile) {
			let inspection;
			try {
				inspection = await this.prompts.inspect(command.sessionId, correlation);
			} catch {
				return this.unknown(command, "reconciliation-unavailable", true);
			}
			if (inspection.kind === "conflict") return this.unknown(command, "correlation-conflict", true);
			if (inspection.kind === "pending") return this.unknown(command, "durability-pending", true);
			if (inspection.kind === "committed") return this.repairCommit(row, inspection);
		}
		if (command.control.sessionId !== command.sessionId || command.control.holderDeviceId !== authority.deviceId) return this.reject(row, "invalid-control-proof");
		const preflight = await this.authorizedAdmission(command, authority, () => void 0);
		if (preflight.kind === "threw") return this.reject(row, "authorization-denied");
		if (preflight.kind === "refused") return this.reject(row, preflight.errorCode);
		let budgetGate;
		try {
			budgetGate = this.policy?.()?.evaluateBudget(command.sessionId);
		} catch {
			budgetGate = void 0;
		}
		if (budgetGate?.exhausted === true) return this.reject(row, "budget-exhausted");
		const prepared = await this.prompts.prepareText({
			sessionId: command.sessionId,
			text: command.text,
			correlation,
			...command.attachmentIds === void 0 ? {} : { images: command.attachmentIds.map((id) => id) }
		});
		if (!prepared.ok) return this.reject(row, prepared.error.code);
		const admitted = await this.authorizedAdmission(command, authority, () => prepared.prepared.admit());
		if (admitted.kind === "threw") return this.unknown(command, "admission-outcome-unknown");
		if (admitted.kind === "refused") return this.reject(row, admitted.errorCode);
		if (!admitted.value.ok) return this.reject(row, admitted.value.error.code);
		const receipt = admitted.value.receipt;
		if (receipt.correlation !== correlation) return this.unknown(command, "correlation-conflict");
		let durable;
		try {
			durable = await receipt.flush();
		} catch {
			return this.unknown(command, "durability-unavailable");
		}
		if (!durable) return this.unknown(command, "durability-unavailable");
		const commit = {
			sessionEventSeq: receipt.sessionEventSeq,
			messageId: receipt.messageId
		};
		try {
			await this.control.commitCommand(command.commandId, row.requestFingerprint, commit);
		} catch (error) {
			this.logger.warn(`remote-command: durable Session input committed but journal repair is pending: ${String(error)}`);
		}
		try {
			receipt.wake();
		} catch (error) {
			this.logger.warn(`remote-command: durable Session input could not wake its Agent: ${String(error)}`);
		}
		return Object.freeze({
			outcome: "committed",
			commandId: command.commandId,
			replayed: false
		});
	}
	async replayCommitted(row) {
		if (!("sessionEventSeq" in row.commit)) return this.unknown({ commandId: row.commandId }, "committed-fact-unavailable", true);
		try {
			const inspected = await this.prompts.inspect(row.sessionId, row.correlation);
			if (inspected.kind !== "committed" || inspected.messageId !== row.commit.messageId || inspected.sessionEventSeq !== row.commit.sessionEventSeq) return this.unknown({ commandId: row.commandId }, "committed-fact-unavailable", true);
			return terminalFromRow(row, true);
		} catch {
			return this.unknown({ commandId: row.commandId }, "reconciliation-unavailable", true);
		}
	}
	async repairCommit(row, inspection) {
		try {
			await this.control.commitCommand(row.commandId, row.requestFingerprint, {
				sessionEventSeq: inspection.sessionEventSeq,
				messageId: inspection.messageId
			});
			if (inspection.pending) try {
				await this.prompts.wakeCorrelated(row.sessionId, row.correlation);
			} catch (error) {
				this.logger.warn(`remote-command: repaired durable input could not wake its Agent: ${String(error)}`);
			}
			return Object.freeze({
				outcome: "committed",
				commandId: row.commandId,
				replayed: true
			});
		} catch {
			return this.unknown({ commandId: row.commandId }, "journal-unavailable", true);
		}
	}
	async executeApproval(authority, command, row, reconcile) {
		if (reconcile) {
			const inspection = await this.inspectApproval(command);
			if (inspection.kind === "conflict") return this.unknown(command, "approval-settlement-conflict", true);
			if (inspection.kind === "decided") {
				if (inspection.outcome !== command.outcome) return this.reject(row, "approval-already-settled");
				return this.repairApprovalCommit(command, row, inspection);
			}
		}
		try {
			authority.authorize();
		} catch {
			return this.reject(row, "authorization-denied");
		}
		if (this.approvals === void 0) return this.reject(row, "approval-owner-unavailable");
		const prepared = this.approvals.prepareDecision({
			sessionId: command.sessionId,
			approvalId: command.approvalId,
			revision: command.approvalRevision,
			outcome: command.outcome
		});
		if (!prepared.ok) return this.reject(row, prepared.error.code);
		if (command.grantSameKind === true) {
			if (command.outcome !== "allowed-once") return this.reject(row, "approval-outcome-not-allowed");
			const policy = this.policy?.();
			if (policy === void 0) return this.reject(row, "approval-policy-unavailable");
			const pending = this.approvals.list(command.sessionId).find((interaction) => String(interaction.approvalId) === command.approvalId);
			if (pending === void 0) return this.reject(row, "approval-not-pending");
			let granted;
			try {
				granted = await policy.grantForApproval({
					sessionId: command.sessionId,
					toolName: pending.toolName,
					...pending.reason === void 0 ? {} : { reason: pending.reason }
				});
			} catch {
				return this.unknown(command, "approval-policy-unavailable");
			}
			if (!granted.ok) return this.reject(row, granted.errorCode);
		}
		let admitted;
		try {
			authority.authorize();
			admitted = prepared.prepared.admit();
		} catch {
			return this.reject(row, "authorization-denied");
		}
		if (!admitted.ok) return this.reject(row, admitted.error.code);
		let settled;
		try {
			settled = await admitted.receipt.settle();
		} catch {
			return this.unknown(command, "approval-settlement-unavailable");
		}
		if (!settled.durable || settled.inspection.kind !== "decided" || settled.inspection.outcome !== command.outcome) return this.unknown(command, settled.inspection.kind === "conflict" ? "approval-settlement-conflict" : "approval-settlement-unavailable");
		try {
			await this.control.commitCommand(row.commandId, row.requestFingerprint, {
				approvalId: command.approvalId,
				outcome: command.outcome,
				decidedEventSeq: settled.inspection.eventSeq
			});
		} catch (error) {
			this.logger.warn(`remote-command: durable approval decision committed but journal repair is pending: ${String(error)}`);
		}
		return Object.freeze({
			outcome: "committed",
			commandId: command.commandId,
			replayed: false
		});
	}
	async replayApproval(command, row) {
		if (!("decidedEventSeq" in row.commit) || row.commit.approvalId !== command.approvalId || row.commit.outcome !== command.outcome) return this.unknown(command, "committed-fact-unavailable", true);
		const inspection = await this.inspectApproval(command);
		if (inspection.kind !== "decided" || inspection.eventSeq !== row.commit.decidedEventSeq || inspection.outcome !== command.outcome) return this.unknown(command, "committed-fact-unavailable", true);
		return terminalFromRow(row, true);
	}
	async repairApprovalCommit(command, row, inspection) {
		try {
			await this.control.commitCommand(row.commandId, row.requestFingerprint, {
				approvalId: command.approvalId,
				outcome: command.outcome,
				decidedEventSeq: inspection.eventSeq
			});
			return Object.freeze({
				outcome: "committed",
				commandId: command.commandId,
				replayed: true
			});
		} catch {
			return this.unknown(command, "journal-unavailable", true);
		}
	}
	async inspectApproval(command) {
		try {
			if (this.approvals === void 0) return { kind: "conflict" };
			return await this.approvals.inspect({
				sessionId: command.sessionId,
				approvalId: command.approvalId
			});
		} catch {
			return { kind: "conflict" };
		}
	}
	async executeStop(authority, command, row, onRequested) {
		const target = Object.freeze({
			sessionId: command.sessionId,
			turn: command.expectedActivityRevision
		});
		if (row.phase === "requested") {
			const recovered = await this.inspectStopped(target);
			if (recovered.kind === "stopped") return this.repairStopCommit(command, row, recovered);
			return this.stopUnknown(command, recovered.kind === "conflict" ? "stop-terminal-conflict" : "stop-settlement-pending", true);
		}
		if (command.control.sessionId !== command.sessionId || command.control.holderDeviceId !== authority.deviceId) return this.rejectStop(row, command, "invalid-control-proof");
		const preflight = await this.authorizedAdmission(command, authority, () => void 0);
		if (preflight.kind === "threw") return this.rejectStop(row, command, "authorization-denied");
		if (preflight.kind === "refused") return this.rejectStop(row, command, preflight.errorCode);
		const prepared = await this.stops.prepare(target);
		if (!prepared.ok) {
			const code = prepared.error.code === "session-not-found" ? "session-not-found" : "activity-revision-stale";
			return this.rejectStop(row, command, code);
		}
		const admitted = await this.authorizedAdmission(command, authority, () => prepared.prepared.admit());
		if (admitted.kind === "threw") return this.stopUnknown(command, "stop-admission-outcome-unknown");
		if (admitted.kind === "refused") return this.rejectStop(row, command, admitted.errorCode);
		if (!admitted.value.ok) return this.rejectStop(row, command, "activity-revision-stale");
		try {
			await this.control.markCommandRequested(row.commandId, row.requestFingerprint, { targetTurn: command.expectedActivityRevision });
		} catch {
			return this.stopUnknown(command, "journal-unavailable");
		}
		this.notifyStopRequested(onRequested, command, false);
		let settled;
		try {
			settled = await admitted.value.receipt.settle();
		} catch {
			return this.stopUnknown(command, "stop-settlement-unavailable");
		}
		if (!settled.durable || settled.inspection.kind !== "stopped") return this.stopUnknown(command, settled.inspection.kind === "conflict" ? "stop-terminal-conflict" : "stop-settlement-unavailable");
		try {
			await this.control.commitCommand(row.commandId, row.requestFingerprint, {
				targetTurn: command.expectedActivityRevision,
				turnEndSeq: settled.inspection.turnEndSeq
			});
		} catch (error) {
			this.logger.warn(`remote-command: durable Stop terminal committed but journal repair is pending: ${String(error)}`);
		}
		return Object.freeze({
			outcome: "stopped",
			commandId: command.commandId,
			expectedActivityRevision: command.expectedActivityRevision,
			replayed: false,
			currentRunning: settled.currentRunning
		});
	}
	async replayStopped(command, row) {
		if (!("turnEndSeq" in row.commit) || row.commit.targetTurn !== command.expectedActivityRevision) return this.stopUnknown(command, "committed-fact-unavailable", true);
		const inspection = await this.inspectStopped({
			sessionId: command.sessionId,
			turn: command.expectedActivityRevision
		});
		if (inspection.kind !== "stopped" || inspection.turnEndSeq !== row.commit.turnEndSeq) return this.stopUnknown(command, "committed-fact-unavailable", true);
		return stopTerminalFromRow(row, command.expectedActivityRevision, true);
	}
	async repairStopCommit(command, row, inspection) {
		try {
			await this.control.commitCommand(row.commandId, row.requestFingerprint, {
				targetTurn: command.expectedActivityRevision,
				turnEndSeq: inspection.turnEndSeq
			});
			return Object.freeze({
				outcome: "stopped",
				commandId: command.commandId,
				expectedActivityRevision: command.expectedActivityRevision,
				replayed: true
			});
		} catch {
			return this.stopUnknown(command, "journal-unavailable", true);
		}
	}
	async inspectStopped(target) {
		try {
			return await this.stops.inspect(target);
		} catch {
			return { kind: "conflict" };
		}
	}
	async rejectStop(row, command, errorCode) {
		try {
			return stopTerminalFromRow(await this.control.rejectCommand(row.commandId, row.requestFingerprint, { code: errorCode }), command.expectedActivityRevision, false);
		} catch {
			return this.stopUnknown(command, "journal-unavailable");
		}
	}
	async reject(row, errorCode) {
		try {
			return terminalFromRow(await this.control.rejectCommand(row.commandId, row.requestFingerprint, { code: errorCode }), false);
		} catch {
			return this.unknown({ commandId: row.commandId }, "journal-unavailable");
		}
	}
	async authorizedAdmission(command, authority, effect) {
		try {
			const result = await this.control.admit(command.control, () => {
				authority.authorize();
			}, effect);
			return result.ok ? {
				kind: "admitted",
				value: result.value
			} : {
				kind: "refused",
				errorCode: `control-${result.reason}`
			};
		} catch {
			return { kind: "threw" };
		}
	}
	notifyReceived(callback, receipt) {
		if (callback === void 0) return;
		try {
			callback(Object.freeze({ ...receipt }));
		} catch (error) {
			this.logger.warn(`remote-command: received receipt delivery failed after durable reservation: ${String(error)}`);
		}
	}
	notifyStopRequested(callback, command, replayed) {
		if (callback === void 0) return;
		try {
			callback(Object.freeze({
				outcome: "requested",
				commandId: command.commandId,
				expectedActivityRevision: command.expectedActivityRevision,
				replayed
			}));
		} catch (error) {
			this.logger.warn(`remote-command: Stop requested delivery failed after durable state: ${String(error)}`);
		}
	}
	async awaitStop(operation, command, replayed) {
		let timer;
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => {
				resolve(this.stopUnknown(command, "stop-settlement-timeout", replayed));
			}, this.stopSettlementTimeoutMs);
		});
		try {
			const result = await Promise.race([operation, timeout]);
			return Object.freeze({
				...result,
				replayed: result.replayed || replayed
			});
		} finally {
			if (timer !== void 0) clearTimeout(timer);
		}
	}
	withReplay(result, replayed) {
		return Object.freeze({
			...result,
			replayed
		});
	}
	unknown(command, errorCode, replayed = false) {
		return Object.freeze({
			outcome: "unknown",
			commandId: command.commandId,
			replayed,
			errorCode
		});
	}
	stopRejected(command, errorCode, replayed = false) {
		return Object.freeze({
			outcome: "rejected",
			commandId: command.commandId,
			expectedActivityRevision: command.expectedActivityRevision,
			replayed,
			errorCode
		});
	}
	stopUnknown(command, errorCode, replayed = false) {
		return Object.freeze({
			outcome: "unknown",
			commandId: command.commandId,
			expectedActivityRevision: command.expectedActivityRevision,
			replayed,
			errorCode
		});
	}
};
//#endregion
//#region src/command/workspace-bind.ts
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/**
* Accept one folder name the Host may mkdir under an already-registered
* parent. Rejects paths, traversal, Windows reserved names, and empty input.
* Unicode is allowed; the absolute path never leaves the Host.
* @param raw - caller-supplied name, possibly dirty.
* @returns the trimmed name, or `undefined` when it cannot be a child folder.
*/
function sanitizeRemoteWorkspaceName(raw) {
	const name = raw.trim();
	if (name.length < 1 || name.length > 64) return void 0;
	if (name === "." || name === "..") return void 0;
	if (/[\\/<>:"|?*\u0000-\u001f]/.test(name)) return void 0;
	if (WINDOWS_RESERVED.test(name)) return void 0;
	return name;
}
/**
* Resolve the workspace a Remote create_session should bind.
* Neither field → Host default cwd (owner omits workspaceId).
* workspaceId only → that registered workspace.
* both → mkdir `name` under the parent, register-or-reuse, bind the child.
* @param input - wire fields plus Host-local list/mkdir/register faces.
*/
async function bindRemoteCreateWorkspace(input) {
	const parentId = input.workspaceId?.trim() || void 0;
	const rawName = input.newWorkspaceName;
	if (rawName !== void 0 && parentId === void 0) return {
		ok: false,
		errorCode: "workspace-invalid-name"
	};
	if (parentId === void 0) return { ok: true };
	let items;
	try {
		items = await input.list();
	} catch {
		return {
			ok: false,
			errorCode: "workspace-create-failed"
		};
	}
	const parent = items.find((item) => item.workspaceId === parentId);
	if (parent === void 0) return {
		ok: false,
		errorCode: "workspace-not-found"
	};
	if (rawName === void 0) return {
		ok: true,
		workspaceId: parent.workspaceId
	};
	const name = sanitizeRemoteWorkspaceName(rawName);
	if (name === void 0) return {
		ok: false,
		errorCode: "workspace-invalid-name"
	};
	let childPath;
	try {
		childPath = await input.mkdir(parent.path, name);
	} catch {
		return {
			ok: false,
			errorCode: "workspace-create-failed"
		};
	}
	const registered = await input.register(childPath);
	if (!registered.ok) return {
		ok: false,
		errorCode: "workspace-create-failed"
	};
	return {
		ok: true,
		workspaceId: registered.workspaceId
	};
}
//#endregion
//#region src/command/index.ts
/** Authenticated Remote command adapter over the Host ApiProxy admission seam. */
/** Stable Cordis function-plugin name. */
const name = "host-remote-command";
/** Transport-neutral DSH admission and durable command authority dependencies. */
const inject = ["apiProxy", "remoteControl"];
/** Bounded owner settlement policy. */
const Config = z.object({ stopSettlementTimeoutMs: z.number().step(1).min(1e3).max(3e5).default(3e4) });
function request(payload) {
	return {
		rpcId: RpcId(`remote-command-${randomUUID()}`),
		payload
	};
}
function errorCodeOf(response, fallback) {
	if (response.result.ok) return fallback;
	return response.result.error.code;
}
/**
* Narrow ApiProxy session-admin face (S-mode-select, S-session-admin). Only
* create, blank-only preset select, next-step model select, and
* preallocated-child fork cross; the privileged authoring verbs stay
* loopback-pinned inside the Host.
*/
async function mkdirChild(parentPath, name) {
	const childPath = join(parentPath, name);
	try {
		await mkdir(childPath);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	return childPath;
}
function createHostSessionAdmin(apiProxy) {
	return Object.freeze({
		async createSession(input) {
			const bound = await bindRemoteCreateWorkspace({
				...input.workspaceId === void 0 ? {} : { workspaceId: input.workspaceId },
				...input.newWorkspaceName === void 0 ? {} : { newWorkspaceName: input.newWorkspaceName },
				list: async () => {
					const listed = await apiProxy.workspace.list(request({}));
					if (!listed.result.ok) throw new Error(listed.result.error.message);
					return listed.result.value.items.map((item) => ({
						workspaceId: String(item.workspaceId),
						path: item.path
					}));
				},
				mkdir: mkdirChild,
				register: async (path) => {
					const created = await apiProxy.workspace.create(request({ path }));
					if (!created.result.ok) return {
						ok: false,
						errorCode: errorCodeOf(created, "workspace-create-failed")
					};
					return {
						ok: true,
						workspaceId: String(created.result.value.workspace.workspaceId)
					};
				}
			});
			if (!bound.ok) return bound;
			const response = await apiProxy.sessions.create(request({
				sessionId: input.sessionId,
				...input.agentPreset === void 0 ? {} : { agentPreset: input.agentPreset },
				...bound.workspaceId === void 0 ? {} : { workspaceId: bound.workspaceId }
			}));
			if (!response.result.ok) return {
				ok: false,
				errorCode: errorCodeOf(response, "session-admin-unavailable")
			};
			return {
				ok: true,
				...response.result.value.agentPreset === void 0 ? {} : { agentPreset: response.result.value.agentPreset }
			};
		},
		async selectAgentPreset(input) {
			const response = await apiProxy.agentPresets.select(request({
				sessionId: input.sessionId,
				agentPreset: input.agentPreset
			}));
			if (!response.result.ok) return {
				ok: false,
				errorCode: errorCodeOf(response, "session-admin-unavailable")
			};
			return { ok: true };
		},
		async selectModel(input) {
			const response = await apiProxy.sessions.selectModel(request({
				sessionId: input.sessionId,
				provider: input.provider,
				model: input.model,
				...input.reasoningEffort === void 0 ? {} : { reasoningEffort: input.reasoningEffort }
			}));
			if (!response.result.ok) return {
				ok: false,
				errorCode: errorCodeOf(response, "session-admin-unavailable")
			};
			return { ok: true };
		},
		async forkSession(input) {
			const response = await apiProxy.sessions.fork(request({
				sessionId: input.sessionId,
				childSessionId: input.childSessionId,
				...input.atSeq === void 0 ? {} : { atSeq: input.atSeq }
			}));
			if (!response.result.ok) {
				if (response.result.error.code === "workspace-attach-failed") return {
					ok: true,
					childSessionId: input.childSessionId
				};
				return {
					ok: false,
					errorCode: errorCodeOf(response, "session-admin-unavailable")
				};
			}
			return {
				ok: true,
				childSessionId: response.result.value.sessionId
			};
		}
	});
}
/**
* Publish the command adapter and drain accepted owners before disposal completes.
* @param ctx - Host context carrying ApiProxy and Remote control authority.
*/
function apply(ctx, config) {
	const executor = new RemoteCommandExecutor(ctx.apiProxy.promptAdmissions, ctx.apiProxy.stopAdmissions, ctx.remoteControl, ctx.logger, config.stopSettlementTimeoutMs ?? 3e4, ctx.apiProxy.approvalInteractions, createHostSessionAdmin(ctx.apiProxy), () => ctx.get("remoteApprovalPolicy"));
	const disposeService = ctx.provide("remoteCommands", executor);
	ctx.effect(() => async () => {
		disposeService();
		await executor.close();
	}, "host-remote-command: command owner");
}
//#endregion
export { Config, apply, bindRemoteCreateWorkspace, inject, name, sanitizeRemoteWorkspaceName };

//# sourceMappingURL=command.mjs.map