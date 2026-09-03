import type { Metadata } from "next";
import "./globals.css";

// 水合失败时（如系统代理拦截 WebSocket）React 代码不会执行，只有内联脚本能兜底：
// 10 秒后若 SSR 加载壳仍在屏上，注入慢加载提示和刷新按钮。水合正常时该节点会被卸载，脚本自动空跑。
const hydrationFallbackScript = `
  window.setTimeout(function () {
    var box = document.querySelector(".app-loading");
    if (!box || box.querySelector(".loading-slow-hint")) return;
    var hint = document.createElement("p");
    hint.className = "loading-slow-hint";
    hint.textContent = "加载比预期慢，可能是网络代理或后台服务未就绪。";
    var retry = document.createElement("button");
    retry.type = "button";
    retry.className = "loading-retry";
    retry.textContent = "刷新页面";
    retry.addEventListener("click", function () { window.location.reload(); });
    box.appendChild(hint);
    box.appendChild(retry);
  }, 10000);
`;

export const metadata: Metadata = {
  title: "知微",
  description: "见微，知著。一个会在长期交流中慢慢懂你的 AI 陪伴应用。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: hydrationFallbackScript }} />
      </body>
    </html>
  );
}

