Hermes HR Admin - 本地测试依赖包
====================================

本压缩包与同版本的源码包 hermes-hr-admin-<版本>-src.zip 配套使用：
1. 先解压源码包，得到 hermes-hr-admin/ 目录
2. 再把本压缩包解压到同一位置，依赖会合并进 hermes-hr-admin/
3. 完成后直接运行：
   - npm run electron:dev   开发调试
   - npm run electron:build 打包安装程序

包含内容：
- node_modules/                Electron / React / SDK 依赖
- resources/hermes/python/     Python 3.11 嵌入式运行时
- resources/hermes/git/        Git for Windows Portable
- resources/hermes/site-packages/  Hermes Python 依赖

注意：依赖包不含任何激活码、API Key、渠道凭据或聊天数据。
