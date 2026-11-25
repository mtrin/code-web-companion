export function logError(action: string, id: string, message: string): void {
  console.error(`${action} ${id}: ${message.replace(/\s*\n\s*/g, ' | ')}`)
}
