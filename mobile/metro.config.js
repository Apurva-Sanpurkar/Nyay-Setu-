// Metro configuration: lets the app import the shared @nyaysetu/integrity
// package (canonical JSON, SHA-256, the capture manifest) from packages/, so the
// phone builds manifests with exactly the code the API verifies them with.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const integrity = path.resolve(projectRoot, "..", "packages", "integrity");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), integrity];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@nyaysetu/integrity": path.join(integrity, "src", "index.ts"),
};
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

module.exports = config;
