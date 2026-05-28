/**
 * Config module — public re-exports.
 */

export {
  loadAllConfigs,
  seedDefaults,
  invalidateConfigCache,
  getConfig,
  getConfigNumber,
  getConfigMs,
  getConfigBoolean,
  getConfigJson,
  updateConfig,
  createConfig,
  deleteConfig,
  _isLoaded,
  _cacheSize,
} from "./service";

export type { ConfigDefault } from "./defaults";
export { CONFIG_DEFAULTS, CONFIG_DEFAULTS_MAP } from "./defaults";
