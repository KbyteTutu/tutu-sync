import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { SERVICE_NAME, SERVICE_VERSION } from './context.js';
import type { Caller } from './lib/auth.js';
import { registerGmailTools } from './tools/gmail.js';
import { registerHostTools } from './tools/host.js';
import { registerPiTools } from './tools/pi.js';
import { registerShareTools } from './tools/share.js';
import { registerWgTools } from './tools/wg.js';

const INSTRUCTIONS = `tutu-mcp 是 tutu 个人基础设施的中心控制面。工具按域分组：host_*（主机接入）、wg_*（内网 WireGuard）、pi_*（pi 模型与扩展）、share_*（文件分享）、gmail_*（邮件）。

身份与权限：
- master 令牌：全部工具，包含签发主机、签发/删除 wg 节点、同步模型规范版、删除分享。
- host 令牌：只读工具（状态/节点清单/模型规范版内容/扩展清单）。
- 邮件域（gmail_*）一律需要 master 令牌（邮箱正文是最敏感数据）。

标准流程：
1. 新主机接入：在有 master 令牌的会话调 tutu_host_enroll(name)，把返回的命令与注册码带到新主机执行；新主机跑完 init.sh 后自带 host 令牌、wg 配置、模型配置与扩展清单。
2. 设备接入（手机等，不跑 pi）：tutu_wg_issue(name)，把返回的客户端配置写入设备。
3. 模型更新：tutu_pi_models（master）刷新中心规范版；其他主机调 tutu_pi_models_get 取同一份写入本机 models.json。返回 needs_research 时按提示检索后带 research 参数重跑。
4. 排查不可用：先 tutu_host_status，按其中的依赖状态定位。`;

/** 每个请求一个实例（stateless HTTP）：注册表复用同一份上下文，开销只是对象构造 */
export function createMcpServer(ctx: AppContext, caller: Caller): McpServer {
  const server = new McpServer(
    { name: SERVICE_NAME, version: SERVICE_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerHostTools(server, ctx, caller);
  registerWgTools(server, ctx, caller);
  registerPiTools(server, ctx, caller);
  registerShareTools(server, ctx, caller);
  registerGmailTools(server, ctx, caller);
  return server;
}
