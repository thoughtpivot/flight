import Router from '@koa/router'
const router = new Router()
router.get('/api/hello', (ctx) => {
    ctx.body = { message: 'Hello from Flight!' }
})
export default router.routes()
