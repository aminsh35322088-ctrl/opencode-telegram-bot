/** Railway infrastructure credentials belong exclusively to the control process. */
export function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !/^RAILWAY_(?:(?:API|PROJECT)_)?TOKEN$/iu.test(name) &&
    !/^(?:CONTROL_NODE_REGISTRY|NODE_SHARED_SECRET)$/iu.test(name),
  ));
}
