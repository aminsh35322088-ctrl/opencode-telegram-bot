import path from "node:path";
import {getRuntimePaths} from "../../runtime/paths.js";

/** Canonical Skill artifact location, shared without loading mutation services. */
export function getGlobalSkillsDir():string{
  return path.join(getRuntimePaths().appHome,".config","opencode","skills");
}
