import rootPackage from '../../../package.json' with { type: 'json' };

/** ProA version: the `version` of the workspace root package.json (`2.0.0-alpha.N`). */
export const PROA_VERSION: string = rootPackage.version;
