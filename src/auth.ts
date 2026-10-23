/** Open the agent plugin schema on the currently active connection. */
export function settingsHref(profile:string):string{
 return '/settings?'+new URLSearchParams({tab:'plugins',agent:'hermes-live',profile}).toString();
}
