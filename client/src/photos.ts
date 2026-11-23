/**
 * Prepara uma foto para envio: o servidor aceita até 3 MB, e fotos de celular costumam passar disso.
 * Reduz o lado maior para 1600 px e recomprime em JPEG quando necessário.
 */
const MAX_BYTES = 2.5 * 1024 * 1024
const MAX_SIDE = 1600
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export async function prepareImage(file: File): Promise<Blob> {
  if (OK_TYPES.includes(file.type) && file.size <= MAX_BYTES) return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('Não foi possível ler a imagem. Use JPEG, PNG ou WebP.')
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
  if (!blob || blob.size > 3 * 1024 * 1024) throw new Error('A imagem continua grande demais após reduzir. Tente outra foto.')
  return blob
}
