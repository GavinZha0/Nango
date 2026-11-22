function readPackage(pkg) {
  if (pkg.name === "@ag-ui/client" && pkg.peerDependencies?.zod) {
    delete pkg.peerDependencies.zod;
    pkg.dependencies = {
      ...pkg.dependencies,
      zod: "^3.25.75",
    };
  }
  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
