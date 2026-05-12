<script setup>
import FeatureGrid from '@components/oss/FeatureGrid.vue';
import Footer from '@components/oss/Footer.vue';
import Spacer from '@components/shared/Spacer.vue';
import { useData } from 'vitepress';
import bg from './hero-bg.jpg';
import Hero from './Hero.vue';

const { frontmatter } = useData();
</script>

<template>
  <Hero :background="bg">
    <template #hero-image>
      <div class="hero-file-tree">
        <VoidAppFileTree />
      </div>
    </template>
  </Hero>

  <Spacer />

  <FeatureGrid />

  <Spacer />

  <Footer
    :heading="frontmatter.footer_heading"
    :subheading="frontmatter.footer_subheading"
    button-text="Get Started"
    button-link="/guide/"
  />
</template>

<style scoped>
.hero-file-tree {
  margin-top: 2rem;
  max-width: calc(100vw - 80px);
}

@media (min-width: 768px) {
  .hero-file-tree {
    margin-top: 0;
    max-width: none;
  }
}

@media (min-width: 1024px) {
  .hero-file-tree :deep(.file-tree) {
    max-height: 362px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.42) rgba(255, 255, 255, 0.08);
  }
}

.hero-file-tree :deep(.file-tree),
.hero-file-tree :deep(.adapter-tabs) {
  background-color: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(10px);
  border-color: rgba(255, 255, 255, 0.1);
}

.hero-file-tree :deep(.file-tree::-webkit-scrollbar) {
  width: 10px;
}

.hero-file-tree :deep(.file-tree::-webkit-scrollbar-track) {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 999px;
}

.hero-file-tree :deep(.file-tree::-webkit-scrollbar-thumb) {
  background: rgba(255, 255, 255, 0.42);
  border: 2px solid rgba(0, 0, 0, 0.35);
  border-radius: 999px;
}

.hero-file-tree :deep(.file-tree::-webkit-scrollbar-thumb:hover) {
  background: rgba(255, 255, 255, 0.58);
}
</style>
