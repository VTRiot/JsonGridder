<svelte:options immutable={true} />

<script lang="ts">
  import type { JSONPath } from 'immutable-json-patch'
  import type { SortedColumn } from '$lib/types.js'
  import { SortDirection } from '$lib/types.js'
  import { stringifyJSONPath } from '$lib/utils/pathUtils.js'
  import Icon from 'svelte-awesome'
  import { faCaretDown, faCaretUp } from '@fortawesome/free-solid-svg-icons'
  import { isEmpty, isEqual } from 'lodash-es'
  import { MAX_HEADER_NAME_CHARACTERS } from '$lib/constants.js'
  import { truncate } from '$lib/utils/stringUtils.js'
  import { t } from '$lib/i18n/index.js'

  export let path: JSONPath
  export let sortedColumn: SortedColumn | undefined
  export let readOnly: boolean
  export let onSort: (sortedColumn: SortedColumn) => void
  // JsonGridder: the shown name in the bottom row of a two-row header (the rest of the path below its
  // parent key). The title and sorting keep the whole path.
  export let label: string | undefined = undefined

  // TODO: improve truncating of long column names when they are a deeply nested path: the last item from the path should be visible, and halfway the path is least interesting
  $: columnName = !isEmpty(path) ? stringifyJSONPath(path) : 'values'
  $: shownName = label ?? columnName

  $: sortDirection =
    sortedColumn && isEqual(path, sortedColumn?.path) ? sortedColumn.sortDirection : undefined

  $: sortDirectionName = sortDirection
    ? sortDirection === SortDirection.asc
      ? $t('sortAscending')
      : $t('sortDescending')
    : undefined

  function handleSort() {
    if (readOnly) {
      return
    }

    onSort({
      path,
      sortDirection: sortDirection === SortDirection.asc ? SortDirection.desc : SortDirection.asc
    })
  }
</script>

<button
  type="button"
  class="jse-column-header"
  class:jse-readonly={readOnly}
  on:click={handleSort}
  title={!readOnly ? columnName + ' ' + $t('clickToSortColumn') : columnName}
>
  <span class="jse-column-name">
    {truncate(shownName, MAX_HEADER_NAME_CHARACTERS)}
  </span>
  {#if sortDirection !== undefined}
    <span class="jse-column-sort-icon" title={$t('currentlySortedIn', { direction: sortDirectionName ?? '' })}>
      <Icon data={sortDirection === SortDirection.asc ? faCaretDown : faCaretUp} />
    </span>
  {/if}
</button>

<style src="./ColumnHeader.scss"></style>
