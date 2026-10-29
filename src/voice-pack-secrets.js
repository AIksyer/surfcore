// 云端凭据边界：只保留一份实现，安装/导入/测试共用。
//
// 背景：voice-cloud / voice-local 的 `config.toml` 里长期放着开发机的火山
// AppID + AccessKey。仓库里只该有 `config.example.toml`，但只要有人把开发目录
// 打成 zip 发出去、或 example 里忘了清，每个装包的用户都会用**我们的额度**计费。
//
// 所以新装/新导入（此前没有用户自己的 config.toml）一律清空这两个键；
// 重装/重新导入时用户已有的 config.toml 原样保留。
export const CLOUD_SECRET_KEYS = ['cloud_app_id', 'cloud_access_key'];

/** 清空 TOML 里的云端凭据行；保留缩进、其余键、注释和 CRLF。 */
export function stripCloudCredentials(toml) {
  let text = String(toml ?? '');
  for (const key of CLOUD_SECRET_KEYS) {
    // 不用 `.*`：CRLF 文件里它会连 \r 一起吃掉，把行尾改成 LF。
    text = text.replace(new RegExp(`^([ \\t]*)${key}([ \\t]*)=[^\\r\\n]*`, 'gm'), `$1${key}$2= ""`);
  }
  return text;
}
