import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";

function prependPath(pathEntries: string[], currentPath?: string): string {
	const parts = [
		...pathEntries.filter(Boolean),
		...(currentPath ? currentPath.split(":").filter(Boolean) : []),
	];

	return [...new Set(parts)].join(":");
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const localBinDir = join(cwd, ".pi", "bin");

	if (!existsSync(localBinDir)) {
		return;
	}

	// Prepend .pi/bin to process.env.PATH so all bash tool spawns (including
	// those from better-bash) inherit it. This avoids registering a competing
	// "bash" tool that would conflict with other extensions.
	process.env.PATH = prependPath([localBinDir], process.env.PATH);

	const withLocalBin = (env: NodeJS.ProcessEnv = {}) => ({
		...env,
		PATH: prependPath([localBinDir], env.PATH ?? process.env.PATH),
	});

	const localBash = createLocalBashOperations();
	pi.on("user_bash", () => ({
		operations: {
			exec(command, userCwd, options) {
				return localBash.exec(command, userCwd, {
					...options,
					env: withLocalBin(options?.env),
				});
			},
		},
	}));
}
