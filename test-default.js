// 注入到 default_app 启动后检查环境
process.once('loaded', () => {
  console.log('LOADED event fired')
})
