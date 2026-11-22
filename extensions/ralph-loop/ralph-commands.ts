// Shared by slash autocomplete, command dispatch, and Ralph Home help.
export const RALPH_COMMANDS = [
	{ value: 'start', usage: 'start [--category <name>] [--goal]', description: 'Start the task or goal loop on the session backlog.' },
	{ value: 'new', usage: 'new [--all]', description: 'Clone the goal and open tasks into a new session (--all includes done tasks).' },
	{ value: 'rollover', usage: 'rollover [--now | --cancel]', description: 'Schedule a new session for the active loop, move now, or cancel.' },
	{ value: 'import', usage: 'import <file | session-id> [--category <name>] [--all | --goal] [--force]', description: 'Import Markdown TODOs or a Ralph backlog into the session backlog.' },
	{ value: 'set-goal', usage: 'set-goal <file.md>', description: 'Set the goal from a Markdown file.' },
	{ value: 'approve', usage: 'approve', description: 'Accept the claimed goal and finish the goal loop.' },
	{ value: 'reject', usage: 'reject <reason>', description: 'Reopen the claimed goal with your feedback and continue working.' },
	{ value: 'review', usage: 'review', description: 'Show the pending decision or the claimed goal and its evidence.' },
	{ value: 'next', usage: 'next', description: 'Preview the next open task and its checkpoint.' },
	{ value: 'away', usage: 'away [on | off]', description: 'Toggle or set Away mode for this session only.' },
	{ value: 'pause', usage: 'pause', description: 'Pause the loop after the current turn without stopping it.' },
	{ value: 'resume', usage: 'resume [note]', description: 'Resume the paused loop and optionally give it direction.' },
	{ value: 'stop', usage: 'stop [--force]', description: 'Stop after the current iteration, or abort immediately with --force.' },
	{ value: 'reload', usage: 'reload', description: 'Reload Pi extensions and resources without losing Ralph state.' },
	{ value: 'status', usage: 'status', description: 'Show the Ralph loop state and session limits.' },
	{ value: 'config', usage: 'config', description: 'Open Ralph settings for the directory or global defaults.' }
] as const;

export const RALPH_COMMAND_SUMMARY = `/ralph [${RALPH_COMMANDS.map(({ value }) => value).join('|')}]`;
