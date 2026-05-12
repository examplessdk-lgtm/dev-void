<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useData } from 'vitepress';

const props = defineProps<{
  background?: string;
}>();

const { frontmatter } = useData();
</script>

<template>
  <div
    v-if="frontmatter.hero"
    class="wrapper wrapper--ticks grid lg:grid-cols-2 w-full border-nickel md:divide-x"
  >
    <div class="flex flex-col p-15 sm:p-20 justify-between gap-20 items-center md:items-start">
      <div class="flex flex-col gap-5 items-center md:items-start text-center md:text-left">
        <a class="flex items-center gap-2" href="https://voidzero.dev" target="_blank">
          <span class="text-grey text-xs font-mono uppercase tracking-wide">By</span>
          <img src="@assets/logos/voidzero-light.svg" alt="VoidZero" class="h-2.5" />
        </a>
        <h1 v-if="frontmatter.hero.text" class="text-white text-pretty max-w-[30rem]">
          {{ frontmatter.hero.text }}
        </h1>
        <p
          v-if="frontmatter.hero.tagline"
          class="text-white/70 md:text-lg max-w-[27rem] text-pretty"
        >
          {{ frontmatter.hero.tagline }}
        </p>
        <div class="flex flex-col min-[410px]:flex-row items-center gap-5 mt-8">
          <a
            v-for="action in frontmatter.hero.actions"
            :key="action.text"
            :href="action.link"
            :target="action.link?.startsWith('http') ? '_blank' : ''"
            class="button inline-block w-fit"
            :class="{ 'button--primary': action.theme === 'brand' }"
          >
            {{ action.text }}
          </a>
        </div>
      </div>
    </div>
    <div class="flex flex-col min-h-[22rem] sm:min-h-[30rem]">
      <div
        class="flex flex-col bg-cover bg-center"
        :style="props.background ? { backgroundImage: `url(${props.background})` } : undefined"
      >
        <div
          class="relative px-10 pb-10 md:pt-10 h-full flex flex-col justify-center overflow-clip"
        >
          <slot name="hero-image">
            <img
              v-if="frontmatter.hero.image?.src"
              :src="frontmatter.hero.image.src"
              :alt="frontmatter.hero.image.alt"
              class="max-h-[20rem]"
            />
          </slot>
        </div>
      </div>
      <a
        href="https://www.youtube.com/watch?v=Bp86buftbX8"
        target="_blank"
        class="p-5 flex gap-5 items-center relative group"
      >
        <div class="relative h-16 aspect-244/144 shrink-0 overflow-hidden">
          <img
            src="./void-thumb.jpg"
            alt="Video thumbnail"
            class="h-16 aspect-244/144 group-hover:opacity-75 group-hover:scale-105 transition-[scale,opacity]"
          />
          <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              class="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 shadow-[0_6px_24px_rgba(0,0,0,0.35)] transition-transform duration-200 group-hover:scale-110"
            >
              <Icon icon="simple-icons:youtube" class="h-5 w-5 text-[#ff0033]" />
            </div>
          </div>
        </div>
        <div>
          <h5 class="text-white">What is Void?</h5>
          <p class="text-base">Evan You announces Void</p>
        </div>
        <span
          class="absolute top-5 right-5 text-electric bg-slate rounded px-3 py-1 text-xs font-mono"
          >15:33</span
        >
      </a>
    </div>
  </div>
</template>
