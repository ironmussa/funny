import whyDidYouRender from '@welldone-software/why-did-you-render';
/// <reference types="@welldone-software/why-did-you-render" />
import * as React from 'react';

if (import.meta.env.DEV) {
  whyDidYouRender(React, {
    trackAllPureComponents: true,
    collapseGroups: true,
  });
}
