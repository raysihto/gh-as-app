import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignore: [".ncurc.cjs"],
  ignoreExportsUsedInFile: true,
};

export default config;
