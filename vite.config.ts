import { builtinModules } from "node:module";
import { defineConfig } from "vite";

function isExternal(id: string): boolean {
  if (id.startsWith("node:")) {
    return true;
  }

  if (builtinModules.includes(id)) {
    return true;
  }

  if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) {
    return false;
  }

  return true;
}

export default defineConfig({
  build: {
    target: "node22",
    outDir: "dist",
    minify: false,
    sourcemap: true,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: isExternal,
      output: {
        banner: "#!/usr/bin/env node",
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
