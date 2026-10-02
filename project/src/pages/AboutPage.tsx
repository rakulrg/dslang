import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/Button';
import { linkHref } from '@/lib/router';

export function AboutPage() {
  return (
    <div className="pt-3">
      <div className="shell pb-12 md:pb-16">
        <header className="border-b border-line pb-6 md:pb-12">
          <p className="font-label text-[10px] uppercase tracking-ultra text-grey mb-2">
            About DSLANG
          </p>
          <h1 className="font-display text-4xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            The Slang Of Design
          </h1>
        </header>

        <p className="mt-8 md:mt-12 max-w-2xl text-bone leading-relaxed text-base md:text-lg">
          DSLANG is a streetwear label that stands for one thing: freedom. Wear what you want,
          unapologetically — no permission, no fitting in, no apologising for who you are. Every
          piece is a quiet rebellion sewn in heavyweight cotton: a refusal to bend to the room,
          printed loud and cut heavy. Conformity had its shot. It didn&apos;t take it.
        </p>

        <div className="mt-10 md:mt-14 flex flex-wrap gap-3">
          <Button href={linkHref('/collections')} variant="primary">
            Shop The Collection <ArrowRight size={15} strokeWidth={2} />
          </Button>
          <Button href={linkHref('/contact')} variant="outline">
            Contact DSLANG
          </Button>
        </div>
      </div>
    </div>
  );
}