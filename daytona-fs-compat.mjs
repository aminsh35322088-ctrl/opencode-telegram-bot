import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

// Daytona Volumes are S3/FUSE-backed. Direct reads/writes work, while rename(2)
// and copy_file_range/copyFile can be unsupported. The bot relies on rename for
// atomic JSON state updates, so preserve native semantics where available and
// fall back to a small-file read/write/unlink replacement only when the mount
// explicitly rejects the operation. Railway never loads this shim.
const originalRename = fsPromises.rename.bind(fsPromises);
const unsupportedRenameCodes = new Set(["ENOSYS", "EOPNOTSUPP", "ENOTSUP", "EXDEV", "EPERM"]);

async function compatibleRename(oldPath, newPath) {
  try {
    await originalRename(oldPath, newPath);
    return;
  } catch (error) {
    if (!unsupportedRenameCodes.has(error?.code)) {
      throw error;
    }
  }

  // Avoid fs.copyFile(): Daytona's S3/FUSE mount can reject that syscall with
  // EPERM even though ordinary readFile/writeFile operations are supported.
  const data = await fsPromises.readFile(oldPath);
  let mode;
  try {
    mode = (await fsPromises.stat(oldPath)).mode & 0o777;
  } catch {
    mode = undefined;
  }

  if (mode === undefined) {
    await fsPromises.writeFile(newPath, data);
  } else {
    await fsPromises.writeFile(newPath, data, { mode });
  }

  await fsPromises.rm(oldPath, { force: true });
}

fsPromises.rename = compatibleRename;
fs.promises.rename = compatibleRename;
syncBuiltinESMExports();
