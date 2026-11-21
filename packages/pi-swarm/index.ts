import { createSwarm } from "./src/extension.ts";

export {
	Board,
	formatPosts,
	type GateResult,
	type GraphEdge,
	type Member,
	type MemberBrief,
	type MemberKind,
	type MemberPhase,
	type MemberStatus,
	type Post,
	type PostKind,
} from "./src/board.ts";
export {
	createSwarm,
	describeSwarm,
	SWARM_BOARD_MESSAGE,
	type SwarmOptions,
	type SwarmOwner,
} from "./src/extension.ts";
export {
	describeGates,
	detectGates,
	type GateRunner,
	runGates,
	runProjectGates,
} from "./src/gates.ts";
export {
	applyPatch,
	changedFiles,
	commitWorktree,
	createWorktree,
	dependencyTargets,
	type ExecResult,
	linkDependencies,
	matchesAny,
	ownershipViolations,
	removeWorktree,
	repoRoot,
	run as runCommand,
	unlinkDependencies,
	type Worktree,
	worktreeDiff,
} from "./src/git.ts";
export { swarmMemberExtension } from "./src/memberExtension.ts";
export { reviewVerdict } from "./src/prompts.ts";
export {
	createFileSwarmStore,
	parseSwarmState,
	SWARM_STATE_VERSION,
	type SwarmLoad,
	type SwarmState,
	type SwarmStore,
} from "./src/store.ts";
export {
	type AddMemberInput,
	type Isolation,
	Swarm,
	type SwarmConfig,
	type SwarmDeps,
	type SwarmSnapshot,
} from "./src/swarm.ts";

export default createSwarm().extension;
