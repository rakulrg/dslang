export function notFound(): import('react').ReactElement {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-5">
      <p className="font-display text-7xl md:text-9xl uppercase tracking-wide-2 text-bone leading-none">
        404
      </p>
      <p className="mt-5 text-sm uppercase tracking-wide-2 text-grey">
        This page sold out.
      </p>
      <a
        href="#/shop"
        className="mt-8 inline-flex items-center text-[11px] uppercase tracking-wide-2 font-semibold bg-crimson text-white px-6 py-4 hover:bg-crimson-dark transition-colors"
      >
        Back To Shop
      </a>
    </div>
  );
}
