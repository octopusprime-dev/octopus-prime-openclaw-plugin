/** This version retires no `channels.octopus-prime` setting: nothing to repair. */
export function normalizeCompatibilityConfig({ cfg }) {
    return { config: cfg, changes: [] };
}
/** No plugin state for Doctor to migrate; matches `doctorContract.stateMigrations`. */
export const stateMigrations = [];
