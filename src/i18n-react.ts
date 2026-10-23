import {useI18n,usePluginI18n} from '@hermes/plugin-sdk';
import type {Translate} from './i18n.ts';
export function useLiveI18n(){
 const {locale}=useI18n();
 const t=usePluginI18n('hermes-live') as Translate;
 return {t,locale};
}
