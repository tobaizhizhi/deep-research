import { registerHooks } from "node:module";

// 独立 Node 测试没有 Next 的分层打包器。仅在测试进程中消除编译标记，
// 保留正常 React（NextAuth 会导入 next/navigation）。应用构建仍检查 server-only。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
