export default defineNuxtRouteMiddleware(() => {
  if (!useFlag('farmView'))
    throw createError({
      statusCode: 404,
      message: 'Página não encontrada',
    })
})
