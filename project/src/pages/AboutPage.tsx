import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/Button';
import { linkHref } from '@/lib/router';

const SECTION_BODY = 'text-bone-soft leading-relaxed text-sm md:text-base';

function StorySection({
  number,
  title,
  first = false,
  children,
}: {
  number: string;
  title: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`grid grid-cols-1 md:grid-cols-12 gap-4 md:gap-8 py-8 md:py-14 ${
        first ? '' : 'border-t border-line'
      }`}
    >
      <div className="md:col-span-4 lg:col-span-5 flex md:flex-col items-baseline gap-3 md:gap-2">
        <span className="font-label text-[10px] uppercase tracking-ultra text-grey shrink-0 md:mt-2">
          {number}
        </span>
        <h2 className="font-display text-3xl md:text-4xl lg:text-5xl uppercase tracking-wide-2 text-bone leading-[0.95] md:leading-none">
          {title}
        </h2>
      </div>
      <div className="md:col-span-8 lg:col-span-7 max-w-prose space-y-4 md:space-y-5">{children}</div>
    </section>
  );
}

export function AboutPage() {
  return (
    <div className="pt-3">
      <div className="mx-auto px-5 md:px-12 lg:px-20 xl:px-28 pb-12 md:pb-16">
        <header className="border-b border-line pb-6 md:pb-12">
          <p className="font-label text-[10px] uppercase tracking-ultra text-grey mb-2">
            About DSLANG
          </p>
          <h1 className="font-display text-4xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            The Slang Of Design
          </h1>
          <p className="mt-4 text-bone-dim max-w-xl leading-relaxed text-sm md:text-base">
            It started with a boy who wanted to build something of his own.
          </p>
        </header>

        <StorySection number="01" title="The Beginning" first>
          <p className={SECTION_BODY}>
            At 22, there was no big studio, no established fashion house, and no perfect roadmap.
          </p>
          <p className={SECTION_BODY}>
            There was just an obsession with clothing, an eye for design, and a belief that
            something built from scratch could become something meaningful.
          </p>
        </StorySection>

        <StorySection number="02" title="The Obsession">
          <p className={SECTION_BODY}>
            Growing up around Tiruppur, garments were never just fabric. They were part of everyday
            life — from the people who made them to the people who wore them. The more he learned
            about the industry, the more he wanted to understand every part of it: the fabric, the
            fit, the weight, the graphics, the stitching, and most importantly, what makes someone
            want to wear a piece again and again.
          </p>
        </StorySection>

        <StorySection number="03" title="The Idea">
          <p className={SECTION_BODY}>He didn't want to simply put a logo on a T-shirt.</p>
          <p className={SECTION_BODY}>
            He wanted to create designs that felt like they belonged to someone.
          </p>
          <p className="pt-1 font-display text-xl md:text-2xl uppercase tracking-wide-2 text-bone leading-tight">
            That Idea Became DSLANG.
          </p>
          <p className={SECTION_BODY}>
            A clothing brand built around design, expression, and the freedom to create without
            following someone else's rules.
          </p>
        </StorySection>

        <StorySection number="04" title="The Making">
          <p className={SECTION_BODY}>
            Every piece begins with an idea. A sketch. A reference. A thought that refuses to leave.
          </p>
          <p className={SECTION_BODY}>
            Then it moves through fabric, colour, fit and countless small decisions until it becomes
            something real.
          </p>
          <p className={SECTION_BODY}>
            We chose oversized silhouettes because we believe clothes should give you room — room
            to move, room to express yourself, room to be whoever you are that day.
          </p>
          <p className={SECTION_BODY}>
            We chose heavyweight 240 GSM cotton because the feeling of a garment matters just as
            much as the design printed on it.
          </p>
          <p className={SECTION_BODY}>
            And we build everything from the ground up because this isn't about making clothes
            quickly.
          </p>
          <p className="pt-1 font-display text-xl md:text-2xl uppercase tracking-wide-2 text-bone leading-tight">
            It's About Building Something Worth Remembering.
          </p>
        </StorySection>

        <StorySection number="05" title="The Dream">
          <p className="font-display uppercase tracking-wide-2 text-bone leading-[1.15] text-xl sm:text-2xl md:text-3xl lg:text-4xl">
            DSLANG is still young.
            <br />
            The dream is not.
          </p>
          <p className={SECTION_BODY}>
            This is the beginning of a long journey — from a 22-year-old's idea to a brand that can
            stand on its own, one design, one drop and one person at a time.
          </p>
          <div className="pt-1 space-y-2">
            <p className="font-label uppercase tracking-wide-2 font-semibold text-bone text-xs md:text-sm">
              Welcome to DSLANG.
            </p>
            <p className="font-display uppercase tracking-wide-2 text-bone text-xl md:text-2xl">
              The Slang of Design.
            </p>
          </div>
        </StorySection>

        <section className="mt-10 md:mt-16 border-t border-line pt-8 md:pt-10 flex flex-wrap gap-3">
          <Button href={linkHref('/collection')} variant="primary">
            Shop The Collection <ArrowRight size={15} strokeWidth={2} />
          </Button>
          <Button href={linkHref('/contact')} variant="outline">
            Contact DSLANG
          </Button>
        </section>
      </div>

      <section className="bg-bone text-paper">
        <div className="mx-auto px-5 md:px-12 lg:px-20 xl:px-28 py-14 md:py-20 lg:py-28 text-center max-w-none">
          <p className="font-display uppercase text-white tracking-[0.12em] md:tracking-wide-2 leading-[1.05] text-2xl sm:text-4xl md:text-5xl lg:text-6xl text-balance">
            This Is Only The First Drop.
          </p>
          <p className="mt-6 md:mt-8 font-brand text-white text-2xl md:text-4xl tracking-[0.1em] leading-none">
            DSLANG
          </p>
          <p className="mt-3 font-display uppercase text-white/60 tracking-[0.28em] md:tracking-ultra text-[10px] md:text-sm">
            The Slang of Design.
          </p>
        </div>
      </section>
    </div>
  );
}