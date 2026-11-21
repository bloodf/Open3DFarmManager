// Copy for the app error page. Messages are fixed: the server's own message is
// never shown, so nothing internal leaks into the page.
export type ErrorKind = 'not-found' | 'forbidden' | 'server'

export type ErrorCopy = {
  kind: ErrorKind
  code: number
  title: string
  description: string
}

export function errorKind(statusCode: number | undefined): ErrorKind {
  if (statusCode === 404) return 'not-found'
  if (statusCode === 401 || statusCode === 403) return 'forbidden'
  return 'server'
}

export function errorCopy(statusCode: number | undefined): ErrorCopy {
  const kind = errorKind(statusCode)
  if (kind === 'not-found')
    return {
      kind,
      code: 404,
      title: 'Página não encontrada',
      description:
        'O endereço não existe ou foi movido. Confira o link ou volte para uma página conhecida.',
    }
  if (kind === 'forbidden')
    return {
      kind,
      code: statusCode === 401 ? 401 : 403,
      title: 'Acesso não permitido',
      description:
        'Esta conta não tem permissão para ver esta página, ou a sessão expirou. Entre com outra conta ou peça acesso a quem administra a farm.',
    }
  return {
    kind,
    code:
      statusCode && statusCode >= 500 && statusCode < 600 ? statusCode : 500,
    title: 'Algo deu errado',
    description:
      'Não foi possível exibir esta página. Tente novamente; se continuar, volte ao início e avise quem administra a farm.',
  }
}
