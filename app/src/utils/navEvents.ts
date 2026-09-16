/**
 * Window events used to coordinate between the nav bar and the pages below it.
 *
 * Kept out of the components themselves so neither has to import the other, and
 * so a component file exports only components.
 */

/**
 * Fired when the brand or the menu's "Reader" entry is clicked.
 *
 * The reader shows one pane at a time on a phone, and which pane is showing is
 * component state rather than a route — so a plain link to "/" while already
 * there would leave a drilled-in story list on screen. The reader listens for
 * this and returns to the feed list.
 */
export const HOME_EVENT = 'rdr:home';

/** Fired after the update daemon runs, or after an admin action changes data. */
export const REFRESHED_EVENT = 'rss:refreshed';
