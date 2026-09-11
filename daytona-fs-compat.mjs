import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

// Daytona Volumes are S3/FUSE-backed. Direct reads/writes work, but rename(2)
// can report ENOSYS. The bot uses rename for atomic JSON state updates, so keep
// native rename semantics everywhere they are supported and fall back to a
// copy+unlink replacement only for filesystems that explicitly reject rename.
const originalRename = fsPromises.rename.bind(fsPromises);
const unsupportedRenameCodes = new Set(["ENOSYS", "EOPNOTSUPP", "ENOTSUP", "EXDEV"]);

async function compatibleRename(oldPath, newPath) {
  try {
    await originalRename(oldPath, newPath);
  } catch (error) {
    if (!unsupportedRenameCodes.has(error?.code)) {
      throw error;
    }

    await fsPromises.copyFile(oldPath, newPath);
    await fsPromises.rm(oldPath, { force: true });
  }
}

fsPromises.rename = compatibleRename;
fs.promises.rename = compatibleRename;
syncBuiltinESMExports();
