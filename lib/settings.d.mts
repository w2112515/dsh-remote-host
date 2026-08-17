import { Context } from "@deepseek-ai/cordis";
//#region src/settings/index.d.ts
/** Stable Cordis function-plugin name. */
declare const name = "client-ui-settings-remote";
/** Connection owns the direct-peer trust fence; Remote itself is optional. */
declare const inject: string[];
/** Register the Host-local-only administration channel. */
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };
//# sourceMappingURL=settings.d.mts.map