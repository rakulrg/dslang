import type { ReactNode } from 'react';

/** Skeleton boxes mirror the site's grey paper-3 fill used as image placeholders. */
function SkeletonBox({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-paper-3 ${className}`} />;
}

/** Ghost of the retail product card: 4:5 image + title + price lines. */
export function ProductCardSkeleton() {
  return (
    <div className="product-card-frame">
      <div className="product-card-scale">
        <div className="flex flex-col">
          <SkeletonBox className="aspect-[4/5] w-full border border-line" />
          <div className="pt-2 md:pt-4 flex flex-col flex-1">
            <SkeletonBox className="h-3.5 w-3/4" />
            <div className="mt-auto pt-3">
              <SkeletonBox className="h-3.5 w-20" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Responsive product grid of skeletons, matching the shop grids (2-up mobile, 4-up desktop). */
export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-0.5 gap-y-6 md:gap-x-8 md:gap-y-10" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <ProductCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** Ghost of a section header row (eyebrow + display heading + "View All"). */
export function SectionHeaderSkeleton() {
  return (
    <div className="flex items-end justify-between md:px-0 mb-3 md:mb-6">
      <div className="w-2/3 space-y-2">
        <SkeletonBox className="h-2 w-16" />
        <SkeletonBox className="h-7 md:h-9 w-full" />
      </div>
      <SkeletonBox className="h-3 w-14 shrink-0" />
    </div>
  );
}

/** Ghost of the homepage's two product sections (New In + Fresh Off The Print Table). */
export function HomeProductSkeleton() {
  return (
    <div aria-hidden="true">
      <section className="mx-auto px-2 md:px-4 lg:px-6 xl:px-8 pt-6 md:pt-10 pb-2">
        <SectionHeaderSkeleton />
        <ProductGridSkeleton count={4} />
      </section>
      <section className="mx-auto px-2 md:px-4 lg:px-6 xl:px-8 pt-10 md:pt-14 pb-12 md:pb-20">
        <SectionHeaderSkeleton />
        <ProductGridSkeleton count={4} />
      </section>
    </div>
  );
}

/** Ghost of the retail product page: responsive gallery block + info column. */
export function SkeletonProductPage() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.65fr_1fr] gap-3 md:gap-8 lg:gap-10" aria-hidden="true">
      <div>
        <SkeletonBox className="aspect-square lg:aspect-[4/5] w-full border border-line" />
      </div>
      <div className="mt-1 md:mt-6 lg:mt-0 space-y-5">
        <div>
          <SkeletonBox className="h-2.5 w-20" />
          <SkeletonBox className="mt-3 h-6 md:h-9 w-3/4" />
          <SkeletonBox className="mt-2 h-3 w-32" />
          <SkeletonBox className="mt-4 h-5 w-28" />
        </div>
        <SkeletonBox className="h-11 w-full border border-line" />
        <div className="flex gap-2">
          {['M', 'L', 'XL'].map((s) => (
            <SkeletonBox key={s} className="h-10 w-16 border border-line" />
          ))}
        </div>
        <div className="flex gap-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonBox key={i} className="w-8 h-8 lg:w-6 lg:h-6 border border-line" />
          ))}
        </div>
        <SkeletonBox className="h-6 w-32" />
        <SkeletonBox className="h-12 w-full" />
        <SkeletonBox className="h-12 w-full" />
      </div>
    </div>
  );
}

/** Shows the skeleton while `loading`; once loaded, cross-fades the real content in. */
export function FadeSwap({
  loading,
  skeleton,
  children,
}: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  if (loading) return <>{skeleton}</>;
  return <div className="animate-fade-in">{children}</div>;
}