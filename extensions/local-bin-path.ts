import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
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

	const withLocalBin = (env: NodeJS.ProcessEnv = {}) => ({
		...env,
		PATH: prependPath([localBinDir], env.PATH ?? process.env.PATH),
	});

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command,
			cwd,
			env: withLocalBin(env),
		}),
	});

	pi.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
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
