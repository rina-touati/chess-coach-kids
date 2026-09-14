const capturedFetch = globalThis.fetch?.bind(globalThis)

export const nativeFetch: typeof fetch = (input, init) => {
  if (!capturedFetch) {
    throw new Error('Native fetch is not available')
  }

  return capturedFetch(input, init)
}
