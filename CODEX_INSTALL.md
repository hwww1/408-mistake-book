# 在另一台 Windows 电脑上由 Codex 自动安装

本仓库已经包含网站源码、本地 408 AI 助手、生产版网页文件和一键安装脚本。新电脑上的 Codex 可以直接读取本文件并完成安装，无需从旧电脑复制 Codex 登录目录。

## 安装前检查

- 新电脑已经安装 Codex，并登录用户自己的 ChatGPT 账号。
- 新电脑已经登录与旧电脑相同的 OneDrive 账号。
- OneDrive 中的 `408AI错题助手数据` 已开始同步。
- 仓库是完整克隆或完整 ZIP 解压结果，不能只下载单个脚本。

## 推荐安装命令

普通用户直接双击仓库根目录：

```text
安装到此电脑.cmd
```

Codex 自动执行时可以使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\migration\安装到此电脑.ps1"
```

脚本会检查所有文件系统磁盘，选择剩余空间最大的磁盘，并安装到：

```text
<磁盘>:\408AI错题助手\程序
<磁盘>:\408AI错题助手\项目源码
```

同时会创建桌面快捷方式“408 AI 错题助手”。

如果用户指定安装位置：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\migration\安装到此电脑.ps1" -Destination "E:\408AI错题助手"
```

## 安装后验证

1. 启动桌面的“408 AI 错题助手”。
2. 检查 `http://127.0.0.1:4184/api/health`。
3. 打开 `http://127.0.0.1:4184/`。
4. 页面顶部应显示本地助手状态；OneDrive 完成同步后，“我的错题”会恢复旧电脑上的内容。
5. AI 分析不可用时，先确认 Codex 已登录，再重启本地助手。

## PDF 资料

PDF 不放在本公开仓库中。使用以下任一方式：

- 在网页点击“连接私有 PDF 仓库”，连接用户自己的 `408-pdf-library`。新电脑需要重新输入只读 fine-grained token。
- 点击“选择本地文件夹”，选择已经复制到新电脑的大容量磁盘中的分节 PDF 文件夹。

令牌只保存在当前浏览器标签页中，不应写入仓库、脚本或配置文件。

## 数据同步和备份

默认同步目录：

```text
%OneDrive%\408AI错题助手数据
```

其中保存错题图片、错误原因、笔记、掌握状态和 AI 分析记录。两台电脑同时编辑时，程序按更新时间合并，并保留删除记录以避免旧错题重新出现。

如果 OneDrive 尚未准备好，可先在旧电脑网站的“我的错题”中导出 JSON 备份，再到新电脑使用“导入备份”。

如果用户要求从 GitHub 完整恢复旧电脑状态，在私有 `408-pdf-library` 仓库中找到：

```text
408AI错题助手-私人数据.zip
408本地PDF清单-SHA256.csv
```

克隆私有仓库后执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\migration\恢复私人错题数据.ps1" -ArchivePath "<私有仓库路径>\408AI错题助手-私人数据.zip"
```

恢复脚本会先把新电脑已有的 OneDrive 数据复制到带时间戳的备份文件夹，然后恢复旧电脑的错题快照和 AI 分析记录。`408本地PDF清单-SHA256.csv` 用于核对 95 份分节 PDF 是否完整。

## 安全边界

不要上传或复制以下内容：

- `.codex/auth.json` 或整个 `.codex` 登录目录；
- GitHub token、密码、Cookie 或浏览器资料；
- `OneDrive/408AI错题助手数据` 中的个人错题；
- 私有 PDF 练习册。

这些内容均不影响从本仓库安装程序。新电脑分别登录 Codex、OneDrive，并在网页重新连接私有 PDF 仓库即可。
