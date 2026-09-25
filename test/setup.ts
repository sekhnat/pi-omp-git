/**
 * Portable Git test isolation: GIT_CONFIG_GLOBAL points at an empty
 * file created here rather than /dev/null, which does not exist on
 * every supported platform. Tests inherit it through `process.env`.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-omp-git-test-"));
const emptyConfig = join(dir, "empty-git-config");
writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
