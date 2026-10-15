<script setup>
import { Icon } from '@iconify/vue';
import { useData } from 'vitepress';
import HomeFeatureVisual from './HomeFeatureVisual.vue';
import HomeResourceCode from './HomeResourceCode.vue';

const { frontmatter } = useData();
</script>

<template>
  <div v-if="frontmatter.features">
    <section
      v-for="feature in frontmatter.features"
      :key="feature.title"
      class="wrapper border-t border-nickel grid md:grid-cols-2"
    >
      <div class="px-5 py-6 md:p-10 flex flex-col justify-between gap-15">
        <div class="flex flex-col gap-5">
          <Icon
            v-if="feature.iconify"
            :icon="feature.iconify"
            class="size-5 text-vite"
            aria-hidden="true"
          />
          <h3 class="text-white text-xl md:text-3xl">{{ feature.title }}</h3>
          <p class="max-w-[25rem] text-white/70 text-base text-pretty">
            <code v-if="feature.command" class="mr-1 outline-none bg-nickel/50 text-vite">{{
              feature.command
            }}</code>
            {{ feature.details }}
          </p>
          <ul v-if="feature.highlights" class="checkmark-list">
            <li v-for="highlight in feature.highlights" :key="highlight">{{ highlight }}</li>
          </ul>
        </div>
        <a
          v-if="feature.guide"
          :href="feature.guide.link"
          class="home-feature-link sdk-feature-link px-3 py-1.5 rounded w-fit inline-flex items-center gap-2 text-sm font-mono focus-visible:outline-2 focus-visible:outline-vite"
        >
          {{ feature.guide.text }}
          <Icon icon="lucide:arrow-up-right" class="size-4" aria-hidden="true" />
        </a>
      </div>
      <div
        class="border-t border-nickel md:border-t-0 min-h-[22rem] sm:min-h-[30rem] min-w-0 flex items-center justify-center"
        :class="[
          feature.visual === 'resources' ? 'md:order-first md:border-r' : 'md:border-l',
          feature.visual === 'resources' ? 'resources-background' : 'bg-primary p-5 sm:p-10',
        ]"
      >
        <HomeResourceCode v-if="feature.visual === 'resources'" />
        <HomeFeatureVisual v-else-if="feature.visual" :kind="feature.visual" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.sdk-feature-link {
  color: var(--color-white);
  background-color: var(--color-nickel);
}

.sdk-feature-link:hover {
  background-color: color-mix(in srgb, var(--color-nickel) 85%, var(--color-white));
}

.resources-background {
  background: var(--color-wine) url('./assets/backgrounds/viteplus.jpg') center / cover;
}
</style>
