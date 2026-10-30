/**
 * 工具回显清洗——规则本体已上移到 @scene/contract（#347），
 * 这里保留 re-export：面板的 import 路径不变，web 与 server 共用同一套判定。
 */
export {
  stripToolEcho,
  removeToolJson,
  TOOL_ECHO_KEYS,
  TOOL_ECHO_MARKERS,
} from "@scene/contract";
