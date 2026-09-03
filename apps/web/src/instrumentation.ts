// Next 只加载 apps/web 下的 env 文件，根目录 .env 承载本地进程运行所需的配置。
// register 在服务器启动、任何请求之前执行；已存在的环境变量优先（compose 注入不受影响）。
// webpack 打包后拿不到模块路径，这里用进程工作目录（本地为 apps/web）显式指到根目录。
// node:path 与 core 都只能在 nodejs 运行时内动态导入，静态导入会破坏 edge bundle。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [{ loadLocalEnv }, { resolve }] = await Promise.all([
      import("@zhiwei/core"),
      import("node:path"),
    ]);
    const envPath = resolve(process.cwd(), "..", "..", ".env");
    loadLocalEnv(envPath);
  }
}
