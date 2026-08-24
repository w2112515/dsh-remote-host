// ../host-workspace/deepseek-harness/packages/client/ui-settings-remote/src/index.ts
var name = "client-ui-settings-remote";
var inject = ["connection"];
function apply(ctx) {
  const connection = ctx.get("connection");
  ctx.effect(() => connection.rpc.handle(
    "/remote-admin",
    (endpoint, payload) => dispatch(ctx, endpoint, payload),
    { authority: "loopback-peer" }
  ), "ui-settings-remote: Host-local administration channel");
}
async function dispatch(ctx, endpoint, payload) {
  try {
    const admin = ctx.get("remotePairingAdmin");
    if (endpoint === "snapshot") {
      assertEmptyPayload(payload);
      return success(snapshot(admin));
    }
    if (admin === void 0) return failure("DSH Remote is not configured on this Host");
    switch (endpoint) {
      case "invitation/create": {
        const profile = profilePayload(payload);
        const value = {
          invitation: admin.createInvitation(profile),
          snapshot: snapshot(admin)
        };
        return success(value);
      }
      case "pairing/confirm": {
        const invitationId = identifierPayload(payload, "invitationId");
        admin.confirm(invitationId);
        return success(snapshot(admin));
      }
      case "pairing/reject": {
        const invitationId = identifierPayload(payload, "invitationId");
        admin.reject(invitationId);
        return success(snapshot(admin));
      }
      case "device/revoke": {
        const deviceId = identifierPayload(payload, "deviceId");
        admin.revoke(deviceId);
        return success(snapshot(admin));
      }
      case "discovery/set": {
        await admin.setLanDiscovery(enabledPayload(payload));
        return success(snapshot(admin));
      }
      default:
        return badRequest("Unknown Remote administration endpoint");
    }
  } catch (error) {
    if (error instanceof InvalidAdminRequest) return badRequest("Invalid Remote administration request");
    ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
    return failure("The Host could not complete this Remote administration action");
  }
}
var DISCOVERY_OFF = { intended: false, published: false };
function snapshot(admin) {
  return admin === void 0 ? { available: false, pendingPairings: [], devices: [], discovery: DISCOVERY_OFF } : {
    available: true,
    pendingPairings: admin.pendingPairings(),
    devices: admin.devices(),
    discovery: admin.discovery()
  };
}
function assertEmptyPayload(payload) {
  if (!isRecord(payload) || Reflect.ownKeys(payload).length !== 0) throw new InvalidAdminRequest("payload must be empty");
}
function identifierPayload(payload, key) {
  if (!isRecord(payload) || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, key) || typeof payload[key] !== "string" || !/^[0-9a-f]{32}$/iu.test(payload[key])) {
    throw new InvalidAdminRequest(`${key} must be a 16-byte hexadecimal identifier`);
  }
  return payload[key];
}
function profilePayload(payload) {
  if (!isRecord(payload) || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, "profile") || payload.profile !== "read-only" && payload.profile !== "approval-reviewer" && payload.profile !== "session-control" && payload.profile !== "session-operator" && payload.profile !== "session-supervisor" && payload.profile !== "host-supervisor") {
    throw new InvalidAdminRequest("profile must be a supported Remote pairing profile");
  }
  return payload.profile;
}
function enabledPayload(payload) {
  if (!isRecord(payload) || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, "enabled") || typeof payload.enabled !== "boolean") {
    throw new InvalidAdminRequest("enabled must be a boolean");
  }
  return payload.enabled;
}
var InvalidAdminRequest = class extends Error {
};
function isRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function success(value) {
  return { ok: true, value };
}
function badRequest(message) {
  return { ok: false, error: { code: "bad-request", message, details: { issues: [] } } };
}
function failure(message) {
  return { ok: false, error: { code: "internal", message, details: {} } };
}
export {
  apply,
  inject,
  name
};
