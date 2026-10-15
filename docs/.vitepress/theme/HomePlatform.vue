<script setup>
import RiveAnimation from '@components/shared/RiveAnimation.vue';
import { Icon } from '@iconify/vue';
import { useData } from 'vitepress';
import appsFieldAnimation from './assets/animations/640_x_320_apps_field_light.riv';
import platformSecurityAnimation from './assets/animations/640_x_320_void_platform_light.riv';
import HomePlatformResourceCode from './HomePlatformResourceCode.vue';

const { frontmatter } = useData();
const featureAnimations = {
  'platform-ai-coding': appsFieldAnimation,
  'platform-security': platformSecurityAnimation,
};
</script>

<template>
  <div class="platform-features" data-theme="light">
    <section
      v-for="feature in frontmatter.platform_features"
      :key="feature.id"
      :aria-labelledby="feature.id"
      class="wrapper border-t border-stroke grid md:grid-cols-2"
    >
      <div class="px-5 py-6 md:p-10 flex flex-col justify-between gap-15">
        <div class="flex flex-col gap-5">
          <Icon :icon="feature.iconify" class="size-5 text-electric" aria-hidden="true" />
          <h3 :id="feature.id" class="text-primary text-xl md:text-3xl">{{ feature.title }}</h3>
          <p class="max-w-[25rem] text-primary/70 text-base text-pretty">{{ feature.details }}</p>
          <ul class="checkmark-list">
            <li v-for="highlight in feature.highlights" :key="highlight">{{ highlight }}</li>
          </ul>
        </div>
        <a
          :href="feature.guide.link"
          class="home-feature-link platform-feature-link px-3 py-1.5 rounded w-fit inline-flex items-center gap-2 text-primary text-sm font-mono focus-visible:outline-2 focus-visible:outline-electric"
        >
          {{ feature.guide.text }}
          <Icon icon="lucide:arrow-up-right" class="size-4" aria-hidden="true" />
        </a>
      </div>
      <div
        class="border-t border-stroke md:border-t-0 min-h-[22rem] sm:min-h-[30rem] min-w-0 flex items-center justify-center"
        :class="[
          feature.id === 'platform-control-plane' ? 'md:order-first md:border-r' : 'md:border-l',
          feature.visual === 'resources' ? 'platform-resources-background' : 'bg-white p-5 sm:p-10',
        ]"
      >
        <HomePlatformResourceCode v-if="feature.visual === 'resources'" />
        <div
          v-else-if="feature.visual === 'rive'"
          class="platform-feature-animation"
          role="img"
          :aria-label="feature.image_alt"
        >
          <RiveAnimation
            :desktop-src="featureAnimations[feature.id]"
            :desktop-width="640"
            :desktop-height="320"
            canvas-class="w-full h-auto"
          />
        </div>
        <img
          v-else
          :src="feature.image"
          :alt="feature.image_alt"
          width="640"
          height="320"
          loading="lazy"
          class="w-full max-w-[40rem] h-auto"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.platform-features {
  background: var(--color-white);
  color: var(--color-primary);
}

.platform-feature-animation {
  width: 100%;
  max-width: 40rem;
}

.platform-resources-background {
  background: var(--color-wine) url('./assets/backgrounds/viteplus.jpg') center / cover;
  overflow: hidden;
}

.platform-features .checkmark-list li {
  color: var(--color-primary);
}

.platform-features .checkmark-list li::before {
  filter: invert(1);
  mix-blend-mode: multiply;
}

.platform-feature-link {
  background: #f2f1f4;
}

.platform-feature-link:hover {
  background: var(--color-stroke);
}
</style>
