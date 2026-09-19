<script setup>
import DefaultTheme from 'vitepress/theme'
import Backdrop from './Backdrop.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #layout-top>
      <Backdrop />
    </template>
  </Layout>
</template>