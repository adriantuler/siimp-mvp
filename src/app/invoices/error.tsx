'use client'

export default function Error({
  error,
  reset
}: { error: Error; reset: () => void }) {
  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-red-700">Falha ao carregar a lista</h2>
      <p className="text-sm text-red-800 mt-2 break-all">{error.message}</p>
      <button
        onClick={() => reset()}
        className="mt-4 px-3 py-2 rounded bg-blue-600 text-white"
      >
        Tentar novamente
      </button>
    </div>
  )
}
