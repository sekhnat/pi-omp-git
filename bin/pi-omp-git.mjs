#!/usr/bin/env node
/**
 * The pi-omp-git companion binary (ticket 24): `pi-omp-git git` opens
 * the interactive Git TUI on its own terminal via the shared
 * @earendil-works/pi-tui component library; `pi-omp-git commit` runs the
 * same agentic commit pipeline as the `/commit` command.
 */
import { cliMain } from "../dist/cli.js";

process.exitCode = await cliMain(process.argv.slice(2));
