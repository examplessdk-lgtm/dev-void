<script setup lang="ts">
import RiveAnimation from '@components/shared/RiveAnimation.vue';
import frameworksAnimation from './assets/animations/640_x_320_vite_frameworks_diamond.riv';
import connectorsAnimation from './assets/animations/640_x_320_void_connectors.riv';

defineProps<{
  kind: 'stack' | 'frameworks';
}>();

const descriptions = {
  stack: 'Animated illustration of Void connectors.',
  frameworks: 'Animated illustration of Void framework integrations.',
};
</script>

<template>
  <div
    class="feature-visual"
    :class="`feature-visual--${kind}`"
    role="img"
    :aria-label="descriptions[kind]"
  >
    <div v-if="kind === 'stack'" class="feature-animation">
      <RiveAnimation
        :desktop-src="connectorsAnimation"
        :desktop-width="640"
        :desktop-height="320"
        canvas-class="w-full h-auto"
      />
    </div>

    <div v-else-if="kind === 'frameworks'" class="feature-animation">
      <RiveAnimation
        :desktop-src="frameworksAnimation"
        :desktop-width="640"
        :desktop-height="320"
        state-machines="State Machine 1"
        canvas-class="w-full h-auto"
      />
    </div>
  </div>
</template>

<style scoped>
.feature-visual {
  display: grid;
  place-items: center;
  width: 100%;
  height: 17rem;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
}

.feature-visual--stack,
.feature-visual--frameworks {
  border: 0;
  background: transparent;
}

.feature-animation {
  width: 100%;
  max-width: 40rem;
}

@media (min-width: 768px) {
  .feature-visual {
    height: 20rem;
  }
}
</style>
