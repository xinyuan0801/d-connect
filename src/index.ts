import { handleCliError, runCli } from "./bootstrap/cli.js";

runCli(process.argv).catch(handleCliError);
