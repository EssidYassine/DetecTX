import Image from "next/image";

/**
 * Affiche statique d'un widget 3D (rendue par Blender, fond transparent).
 * Volontairement sans dépendance three.js : sert d'état de chargement des scènes
 * (importées en différé) et de repli si WebGL est indisponible.
 */
export function ScenePoster({ src, hidden = false }: { src: string; hidden?: boolean }) {
  return (
    <Image
      src={src}
      alt=""
      fill
      sizes="(max-width: 1024px) 100vw, 50vw"
      loading="eager"
      className={`pointer-events-none select-none object-contain transition-opacity duration-700 ${
        hidden ? "opacity-0" : "opacity-100"
      }`}
    />
  );
}
